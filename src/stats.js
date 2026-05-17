/**
 * DIBI8coin 矿池统计模块
 * 负责矿工追踪、算力统计、排行榜
 */

class PoolStats {
    constructor(config = {}) {
        this.windowMs = config.windowMs || 60000; // 1分钟窗口
        this.cleanupInterval = config.cleanupInterval || 60000;
        this.topMinersLimit = config.topMinersLimit || 50;
        this.hashesPerDiff = config.hashesPerDiff || 4294967296; // 2^32
        
        // PPLNS 核心配置
        this.pplnsN = config.pplnsN || 1000; // 窗口大小 (最近 N 个 Share)
        this.shares = []; // 存储最近的 Share: [{ address, workerId, difficulty, timestamp }]

        this.shareWindow = []; // [{ address, workerId, difficulty, timestamp }]
        
        // 矿工数据: { address: { hashCount, lastSeen, totalBlocks, balance, workers: {} } }
        this.miners = {};

        this.payouts = [];
        
        // 矿池总统计
        this.poolStats = {
            totalBlocks: 0,
            totalHashrate: 0,
            startTime: Date.now()
        };
        
        // 最近出块记录
        this.recentBlocks = [];
        
        // 启动清理定时器
        this.startCleanup();
    }

    /**
     * 记录一次挖矿提交 (Share)
     * @param {string} minerAddress - 矿工钱包地址
     * @param {string} workerId - 矿机ID
     * @param {object} shareInfo - 份额信息 { difficulty, isBlock, height, hash, reward }
     */
    recordMine(minerAddress, workerId = 'default', shareInfo = {}) {
        const now = Date.now();
        const address = minerAddress || 'anonymous';
        const diff = shareInfo.difficulty || 1;
        
        // 1. 初始化矿工基础数据
        if (!this.miners[address]) {
            this.miners[address] = {
                lastSeen: now,
                totalBlocks: 0,
                balance: 0, // 已结算余额
                totalPaid: 0,
                payouts: [],
                workers: {}
            };
        }
        
        const miner = this.miners[address];
        miner.lastSeen = now;
        
        if (!miner.workers[workerId]) {
            miner.workers[workerId] = { lastSeen: now };
        }
        miner.workers[workerId].lastSeen = now;

        this.shareWindow.push({
            address,
            workerId,
            difficulty: diff,
            timestamp: now
        });

        // 2. 核心：将该 Share 放入 PPLNS 窗口
        this.shares.push({
            address,
            workerId,
            difficulty: diff,
            timestamp: now
        });

        // 保持窗口大小为 N
        if (this.shares.length > this.pplnsN) {
            this.shares.shift();
        }
        
        // 3. 如果这个 Share 真正找到了一个区块，触发 PPLNS 收益结算
        if (shareInfo.isBlock) {
            this.processPPLNS(shareInfo);
        }
        
        return true;
    }

    /**
     * PPLNS 收益结算逻辑
     * 当矿池发现新区块时，根据最近 N 个 Share 分配收益
     */
    processPPLNS(blockInfo) {
        const totalReward = blockInfo.reward || 100;
        const poolFee = 0.01; // 1% 矿池手续费
        const rewardToDistribute = totalReward * (1 - poolFee);

        if (blockInfo && blockInfo.minerAddress) {
            const winner = blockInfo.minerAddress;
            if (!this.miners[winner]) {
                this.miners[winner] = {
                    lastSeen: Date.now(),
                    totalBlocks: 0,
                    balance: 0,
                    totalPaid: 0,
                    payouts: [],
                    workers: {}
                };
            }
            this.miners[winner].totalBlocks += 1;
        }

        // 计算窗口内总难度
        const totalWindowDiff = this.shares.reduce((sum, s) => sum + s.difficulty, 0);
        
        if (totalWindowDiff <= 0) return;

        // 按 Share 贡献比例分配
        this.shares.forEach(share => {
            const minerReward = (share.difficulty / totalWindowDiff) * rewardToDistribute;
            if (this.miners[share.address]) {
                this.miners[share.address].balance += minerReward;
            }
        });

        // 更新统计
        this.poolStats.totalBlocks += 1;
        this.recentBlocks.unshift({
            height: blockInfo.height,
            hash: blockInfo.hash,
            miner: blockInfo.minerAddress, // 真正出块的人
            timestamp: Date.now(),
            reward: totalReward
        });
        if (this.recentBlocks.length > 100) this.recentBlocks.pop();

        console.log(`[PPLNS] 区块 #${blockInfo.height} 已结算. 参与份额: ${this.shares.length}, 总难度: ${totalWindowDiff.toFixed(2)}`);
    }

    computeHashrateHps(totalDiff, windowMs) {
        const seconds = Math.max(1, (windowMs || this.windowMs) / 1000);
        return Math.round((Number(totalDiff) * this.hashesPerDiff) / seconds);
    }

    /**
     * 获取矿池统计数据
     */
    getStats() {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        
        const windowShares = [];
        for (let i = this.shareWindow.length - 1; i >= 0; i -= 1) {
            const s = this.shareWindow[i];
            if (!s || s.timestamp < cutoff) break;
            windowShares.push(s);
        }

        // 计算活跃矿工
        const perMiner = new Map();
        const perMinerWorkers = new Map();
        let totalDiff = 0;
        windowShares.forEach((s) => {
            totalDiff += s.difficulty || 0;
            perMiner.set(s.address, (perMiner.get(s.address) || 0) + (s.difficulty || 0));
            if (!perMinerWorkers.has(s.address)) perMinerWorkers.set(s.address, new Set());
            perMinerWorkers.get(s.address).add(s.workerId || 'default');
        });

        const totalHashrateHps = this.computeHashrateHps(totalDiff, this.windowMs);
        const activeMiners = Array.from(perMiner.entries()).map(([address, minerDiff]) => {
            const miner = this.miners[address];
            return {
                address: this.maskAddress(address),
                fullAddress: address,
                hashrateHps: this.computeHashrateHps(minerDiff, this.windowMs),
                totalBlocks: miner ? miner.totalBlocks : 0,
                workerCount: perMinerWorkers.get(address) ? perMinerWorkers.get(address).size : 0,
                percentage: totalDiff > 0 ? ((minerDiff / totalDiff) * 100).toFixed(2) : '0.00'
            };
        });
        
        // 排序
        activeMiners.sort((a, b) => b.hashrateHps - a.hashrateHps);
        const topMiners = activeMiners.slice(0, this.topMinersLimit);
        
        return {
            poolName: 'DIBI8coin Pool',
            poolHashrateHps: totalHashrateHps,
            minerCount: activeMiners.length,
            blockHeight: this.poolStats.totalBlocks,
            uptime: Math.floor((now - this.poolStats.startTime) / 1000),
            topMiners,
            recentBlocks: this.recentBlocks.slice(0, 10)
        };
    }

    /**
     * 获取单个矿工信息
     */
    getMiner(address) {
        const miner = this.miners[address];
        if (!miner) return null;
        
        const cutoff = Date.now() - this.windowMs;
        let minerDiff = 0;
        const workers = new Map();
        for (let i = this.shareWindow.length - 1; i >= 0; i -= 1) {
            const s = this.shareWindow[i];
            if (!s || s.timestamp < cutoff) break;
            if (s.address !== address) continue;
            minerDiff += s.difficulty || 0;
            const workerId = s.workerId || 'default';
            workers.set(workerId, (workers.get(workerId) || 0) + (s.difficulty || 0));
        }

        return {
            address,
            hashrateHps: this.computeHashrateHps(minerDiff, this.windowMs),
            totalBlocks: miner.totalBlocks,
            balance: miner.balance,
            totalPaid: miner.totalPaid || 0,
            payouts: Array.isArray(miner.payouts) ? miner.payouts.slice(0, 20) : [],
            workers: Array.from(workers.entries()).map(([id, diff]) => ({
                id,
                hashrateHps: this.computeHashrateHps(diff, this.windowMs),
                lastSeen: miner.workers[id] ? miner.workers[id].lastSeen : miner.lastSeen
            })),
            lastSeen: miner.lastSeen
        };
    }

    listMinersForPayout({ minBalance, maxCount } = {}) {
        const min = Number(minBalance || 0);
        const limit = Math.max(1, Math.min(1000, Number(maxCount || 200)));
        const out = [];
        for (const [address, miner] of Object.entries(this.miners)) {
            if (!miner) continue;
            const bal = Number(miner.balance || 0);
            if (!Number.isFinite(bal) || bal <= 0) continue;
            if (bal < min) continue;
            out.push({ address, balance: bal, lastSeen: miner.lastSeen || 0 });
        }
        out.sort((a, b) => (b.balance - a.balance) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
        return out.slice(0, limit);
    }

    applyPayout({ address, amount, txid, timestamp } = {}) {
        if (!address || !this.miners[address]) return false;
        const miner = this.miners[address];
        const amt = Number(amount || 0);
        if (!Number.isFinite(amt) || amt <= 0) return false;
        const now = Number(timestamp || Date.now());
        const payout = { txid: String(txid || ''), amount: amt, timestamp: now };
        miner.balance = Math.max(0, Number(miner.balance || 0) - amt);
        miner.totalPaid = Number(miner.totalPaid || 0) + amt;
        if (!Array.isArray(miner.payouts)) miner.payouts = [];
        miner.payouts.unshift(payout);
        if (miner.payouts.length > 200) miner.payouts.pop();
        this.payouts.unshift({ address, ...payout });
        if (this.payouts.length > 2000) this.payouts.pop();
        return true;
    }

    getRecentPayouts({ address, limit } = {}) {
        const lim = Math.max(1, Math.min(200, Number(limit || 20)));
        if (address) {
            const miner = this.miners[address];
            if (!miner || !Array.isArray(miner.payouts)) return [];
            return miner.payouts.slice(0, lim);
        }
        return Array.isArray(this.payouts) ? this.payouts.slice(0, lim) : [];
    }

    /**
     * 掩码地址显示
     */
    maskAddress(address) {
        if (!address || address.length <= 16) return address;
        return address.substring(0, 8) + '...' + address.substring(address.length - 6);
    }

    /**
     * 清理过期数据
     */
    cleanup() {
        const cutoff = Date.now() - this.windowMs * 2; // 2个窗口后清理

        const shareCutoff = Date.now() - this.windowMs * 2;
        if (this.shareWindow.length) {
            this.shareWindow = this.shareWindow.filter(s => s && s.timestamp >= shareCutoff);
        }
        
        for (const [address, data] of Object.entries(this.miners)) {
            if (data.lastSeen < cutoff) {
                // 清理过期矿机
                for (const [workerId, worker] of Object.entries(data.workers)) {
                    if (worker.lastSeen < cutoff) {
                        delete this.miners[address].workers[workerId];
                    }
                }
            }
        }
    }

    /**
     * 启动清理定时器
     */
    startCleanup() {
        setInterval(() => this.cleanup(), this.cleanupInterval);
    }

    /**
     * 重置窗口内的算力计数 (每分钟调用)
     */
    resetWindowHashrates() {
        return;
    }
}

module.exports = PoolStats;
