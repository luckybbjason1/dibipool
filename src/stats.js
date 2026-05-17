/**
 * DIBI8coin 矿池统计模块
 * 负责矿工追踪、算力统计、排行榜
 */

class PoolStats {
    constructor(config = {}) {
        this.windowMs = config.windowMs || 60000; // 1分钟窗口
        this.cleanupInterval = config.cleanupInterval || 60000;
        this.topMinersLimit = config.topMinersLimit || 50;
        
        // PPLNS 核心配置
        this.pplnsN = config.pplnsN || 1000; // 窗口大小 (最近 N 个 Share)
        this.shares = []; // 存储最近的 Share: [{ address, workerId, difficulty, timestamp }]
        
        // 矿工数据: { address: { hashCount, lastSeen, totalBlocks, balance, workers: {} } }
        this.miners = {};
        
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
                hashCount: 0,
                lastSeen: now,
                totalBlocks: 0,
                balance: 0, // 已结算余额
                workers: {}
            };
        }
        
        const miner = this.miners[address];
        miner.hashCount += diff;
        miner.lastSeen = now;
        
        if (!miner.workers[workerId]) {
            miner.workers[workerId] = { hashCount: 0, lastSeen: now };
        }
        miner.workers[workerId].hashCount += diff;
        miner.workers[workerId].lastSeen = now;

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
                    hashCount: 0,
                    lastSeen: Date.now(),
                    totalBlocks: 0,
                    balance: 0,
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

    /**
     * 获取矿池统计数据
     */
    getStats() {
        const now = Date.now();
        const cutoff = now - this.windowMs;
        
        // 计算活跃矿工
        const activeMiners = [];
        let totalHashrate = 0;
        
        for (const [address, data] of Object.entries(this.miners)) {
            if (data.lastSeen >= cutoff) {
                const hashrate = data.hashCount;
                totalHashrate += hashrate;
                activeMiners.push({
                    address: this.maskAddress(address),
                    fullAddress: address,
                    hashrate,
                    totalBlocks: data.totalBlocks,
                    workerCount: Object.keys(data.workers).length,
                    percentage: 0
                });
            }
        }
        
        // 计算占比
        activeMiners.forEach(m => {
            m.percentage = totalHashrate > 0 
                ? ((m.hashrate / totalHashrate) * 100).toFixed(2) 
                : '0.00';
        });
        
        // 排序
        activeMiners.sort((a, b) => b.hashrate - a.hashrate);
        const topMiners = activeMiners.slice(0, this.topMinersLimit);
        
        return {
            poolName: 'DIBI8coin Pool',
            totalHashrate,
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
        
        return {
            address,
            hashrate: miner.hashCount,
            totalBlocks: miner.totalBlocks,
            balance: miner.balance,
            workers: Object.entries(miner.workers).map(([id, w]) => ({
                id,
                hashrate: w.hashCount,
                lastSeen: w.lastSeen
            })),
            lastSeen: miner.lastSeen
        };
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
        
        for (const [address, data] of Object.entries(this.miners)) {
            if (data.lastSeen < cutoff) {
                // 重置算力计数，但保留总区块数
                this.miners[address].hashCount = 0;
                
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
        for (const address of Object.keys(this.miners)) {
            this.miners[address].hashCount = 0;
            for (const workerId of Object.keys(this.miners[address].workers)) {
                this.miners[address].workers[workerId].hashCount = 0;
            }
        }
    }
}

module.exports = PoolStats;
