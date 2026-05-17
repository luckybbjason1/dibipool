/**
 * DIBI8coin 矿池服务器 (WebSocket 高性能版)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const PoolStats = require('./stats.js');

const configPath = path.join(__dirname, '../config/pool.json');
const configLocalPath = path.join(__dirname, '../config/pool.local.json');

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) return override;
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
        if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v);
        else out[k] = v;
    }
    return out;
}

let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (fs.existsSync(configLocalPath)) {
    const localCfg = JSON.parse(fs.readFileSync(configLocalPath, 'utf8'));
    config = mergeDeep(config, localCfg);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());
app.use(cors());

// 初始化统计模块
const stats = new PoolStats(config.stats);

/**
 * 核心 JSON-RPC 客户端 (对接真实节点)
 */
class NodeRPC {
    constructor(nodeConfig) {
        this.url = nodeConfig.rpcUrl;
        this.auth = {
            username: nodeConfig.rpcUser,
            password: nodeConfig.rpcPass
        };
        this.client = axios.create({
            baseURL: this.url,
            auth: this.auth,
            timeout: 5000
        });
    }

    async call(method, params = []) {
        try {
            const response = await this.client.post('/', {
                jsonrpc: "2.0",
                id: Date.now(),
                method: method,
                params: params
            });
            if (response.data.error) throw new Error(response.data.error.message);
            return response.data.result;
        } catch (err) {
            // 仅在首次失败或状态变化时记录日志，避免刷屏
            if (!this.lastError || this.lastError !== err.message) {
                console.error(`[Node RPC] 进入降级模式: 无法连接至节点 (${err.message})`);
                this.lastError = err.message;
            }
            return null;
        }
    }
}

const nodeConfig = config.node || {};
const nodeRuntimeConfig = {
    ...nodeConfig,
    apiUrl: process.env.DIBI8_API_URL || nodeConfig.apiUrl,
    rpcUrl: process.env.DIBI8_RPC_URL || nodeConfig.rpcUrl,
    rpcUser: process.env.DIBI8_RPC_USER || nodeConfig.rpcUser,
    rpcPass: process.env.DIBI8_RPC_PASS || nodeConfig.rpcPass
};

const rpc = new NodeRPC(nodeRuntimeConfig);
const nodeApi = axios.create({
    baseURL: nodeRuntimeConfig.apiUrl,
    timeout: 10000
});

// 防作弊：记录已使用的 Nonce 防止重放攻击
const usedNonces = new Set();

const antiCheatConfig = config.antiCheat || (config.pool && config.pool.antiCheat) || {};
const rateWindowMs = antiCheatConfig.rateWindowMs || 10000;
const maxConnectionsPerIp = antiCheatConfig.maxConnectionsPerIp || 25;
const banMs = antiCheatConfig.banMs || 10 * 60 * 1000;
const vardiffEnabled = antiCheatConfig.vardiffEnabled !== false;
const vardiffAdjustMs = antiCheatConfig.vardiffAdjustMs || 15000;
const vardiffTargetShareTimeMs = antiCheatConfig.vardiffTargetShareTimeMs || 15000;
const vardiffMinDiff = antiCheatConfig.vardiffMinDiff || 1;
const vardiffMaxDiff = antiCheatConfig.vardiffMaxDiff || 1024;
const acceptedSharesPerWindow = antiCheatConfig.acceptedSharesPerWindow || (maxConnectionsPerIp * 10);

const ipBans = new Map();
const ipRates = new Map();
const ipConnections = new Map();
const ipAccepted = new Map();

function isValidDibiAddress(address) {
    if (typeof address !== 'string') return false;
    const a = address.trim().toLowerCase();
    if (!a.startsWith('dibi1')) return false;
    const body = a.slice(5);
    if (!body) return false;
    if (body.length < 20 || body.length > 120) return false;
    return /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(body);
}

function normalizeIp(ip) {
    if (!ip) return 'unknown';
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
}

function getSocketIp(socket) {
    const forwarded = socket.handshake && socket.handshake.headers && socket.handshake.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        return normalizeIp(forwarded.split(',')[0].trim());
    }
    return normalizeIp(socket.handshake && socket.handshake.address);
}

function isIpBanned(ip) {
    const until = ipBans.get(ip);
    if (!until) return false;
    if (until <= Date.now()) {
        ipBans.delete(ip);
        return false;
    }
    return true;
}

function getEventLimit(eventName) {
    const limits = antiCheatConfig.eventLimits || {};
    if (typeof limits[eventName] === 'number') return limits[eventName];
    if (eventName === 'submit_share') return 1500;
    if (eventName === 'mining_auth') return 40;
    if (eventName === 'subscribe_stats') return 120;
    return 300;
}

function registerEvent(ip, eventName) {
    const now = Date.now();
    const entry = ipRates.get(ip) || { windowStart: now, counts: {}, strikes: 0 };
    if (now - entry.windowStart > rateWindowMs) {
        entry.windowStart = now;
        entry.counts = {};
    }
    entry.counts[eventName] = (entry.counts[eventName] || 0) + 1;
    const limit = getEventLimit(eventName);
    const exceeded = entry.counts[eventName] > limit;
    if (exceeded) {
        entry.strikes += 1;
        if (entry.strikes >= 3) {
            ipBans.set(ip, now + banMs);
        }
    } else if (entry.strikes > 0 && now - entry.windowStart > rateWindowMs / 2) {
        entry.strikes -= 1;
    }
    ipRates.set(ip, entry);
    return !exceeded;
}

function toTargetHex(targetBigInt) {
    let hex = targetBigInt.toString(16);
    if (hex.length > 64) hex = hex.slice(-64);
    return hex.padStart(64, '0');
}

function getShareTargetForDifficulty(shareTargetHex, difficulty) {
    const base = BigInt('0x' + shareTargetHex);
    const d = BigInt(Math.max(1, Math.floor(difficulty || 1)));
    const t = base / d;
    return toTargetHex(t <= 0n ? 1n : t);
}

function clampDifficulty(diff) {
    const d = Math.max(vardiffMinDiff, Math.min(vardiffMaxDiff, Math.floor(diff || 1)));
    return d < 1 ? 1 : d;
}

function bumpAccepted(ip) {
    const now = Date.now();
    const entry = ipAccepted.get(ip) || { windowStart: now, accepted: 0 };
    if (now - entry.windowStart > rateWindowMs) {
        entry.windowStart = now;
        entry.accepted = 0;
    }
    entry.accepted += 1;
    ipAccepted.set(ip, entry);
    if (entry.accepted > acceptedSharesPerWindow) {
        ipBans.set(ip, now + banMs);
        return false;
    }
    return true;
}

let currentJob = {
    header: crypto.randomBytes(32).toString('hex'),
    height: 0,
    // 矿池份额难度 (比全网难度低，用于统计贡献)
    shareTarget: "00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    difficulty: 1
};

/**
 * 验证份额 (Share) 是否合法
 */
function verifyShare(header, nonce, target) {
    const data = header + nonce.toString(16).padStart(8, '0');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    // 哈希值必须小于等于目标难度
    return BigInt('0x' + hash) <= BigInt('0x' + target);
}

/**
 * 刷新挖矿任务 (Poll 模式)
 */
async function refreshJob() {
    const template = await rpc.call('getblocktemplate', [{ rules: ['segwit'] }]);
    
    if (template) {
        const newHeader = crypto.createHash('sha256').update(template.previousblockhash + template.curtime).digest('hex');
        
        // 如果高度变化，通知所有矿工并重置 Nonce 记录
        if (template.height !== currentJob.height) {
            console.log(`[Pool] 检测到新高度: ${template.height}, 已重置 Nonce 记录`);
            usedNonces.clear();
            currentJob = {
                header: newHeader,
                height: template.height,
                target: template.target,
                shareTarget: "00000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", // 矿池接受的最低难度
                difficulty: 1,
                template: template
            };
            io.emit('mining_job', {
                header: currentJob.header,
                difficulty: currentJob.difficulty,
                height: currentJob.height,
                shareTarget: currentJob.shareTarget
            });
        }
    } else {
        // 降级处理...
    }
}

// 每 10 秒刷新一次任务
setInterval(refreshJob, 10000);

// ==================== 核心逻辑 ====================

/**
 * 哈希验证逻辑 (防作弊基础)
 */
function verifyWork(minerAddress, nonce, blockHeader) {
    // 简单的 SHA-256 模拟验证
    const content = `${blockHeader}${nonce}${minerAddress}`;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    // 这里未来可以对接真实的 DIBI8 难度验证
    return hash;
}

/**
 * 向节点发送请求
 */
async function nodeRequest(method, url, data = null) {
    try {
        const response = method === 'get' 
            ? await nodeApi.get(url)
            : await nodeApi.post(url, data);
        return response.data;
    } catch (err) {
        console.error(`[Pool] 节点请求失败: ${err.message}`);
        throw err;
    }
}

// ==================== WebSocket 通信 ====================

io.on('connection', (socket) => {
    const ip = getSocketIp(socket);
    if (isIpBanned(ip)) {
        socket.emit('rate_limited', { success: false, message: 'IP Banned' });
        return socket.disconnect(true);
    }

    const activeConn = (ipConnections.get(ip) || 0) + 1;
    ipConnections.set(ip, activeConn);
    if (activeConn > maxConnectionsPerIp) {
        ipBans.set(ip, Date.now() + banMs);
        socket.emit('rate_limited', { success: false, message: 'Too Many Connections' });
        socket.disconnect(true);
        ipConnections.set(ip, Math.max(0, (ipConnections.get(ip) || 1) - 1));
        return;
    }

    console.log(`[WS] 矿工连接: ${socket.id}`);

    // 1. 订阅实时统计
    socket.on('subscribe_stats', () => {
        if (!registerEvent(ip, 'subscribe_stats') || isIpBanned(ip)) {
            socket.emit('rate_limited', { success: false, message: 'Rate Limited' });
            return socket.disconnect(true);
        }
        socket.join('stats_room');
        socket.emit('stats_update', stats.getStats());
    });

    // 2. 初始挖矿握手
    socket.on('mining_auth', (data) => {
        if (!registerEvent(ip, 'mining_auth') || isIpBanned(ip)) {
            socket.emit('rate_limited', { success: false, message: 'Rate Limited' });
            return socket.disconnect(true);
        }
        const { address, worker } = data;
        if (!isValidDibiAddress(address)) {
            socket.emit('auth_result', { success: false, message: 'Invalid Wallet Address (dibi1...)' });
            return socket.disconnect(true);
        }
        socket.minerAddress = address || 'anonymous';
        socket.workerId = worker || 'ws_worker';
        socket.shareDifficulty = clampDifficulty(socket.shareDifficulty || 1);
        socket.shareTarget = getShareTargetForDifficulty(currentJob.shareTarget, socket.shareDifficulty);
        socket.vardiff = {
            windowStart: Date.now(),
            accepted: 0,
            lastAdjust: 0
        };
        console.log(`[WS] 矿工认证: ${socket.minerAddress} (${socket.workerId})`);
        
        // 推送当前任务 (真实数据)
        socket.emit('auth_result', { success: true });
        socket.emit('mining_job', {
            header: currentJob.header,
            difficulty: socket.shareDifficulty,
            height: currentJob.height,
            shareTarget: socket.shareTarget
        });
    });

    // 3. 提交份额 (Share)
    socket.on('submit_share', async (data) => {
        if (!registerEvent(ip, 'submit_share') || isIpBanned(ip)) {
            socket.emit('share_result', { success: false, message: 'Rate Limited' });
            return socket.disconnect(true);
        }
        const { nonce, header } = data;
        
        // 防作弊 1：验证任务是否过期 (Stale Share)
        if (header !== currentJob.header) {
            return socket.emit('share_result', { success: false, message: 'Stale Share' });
        }

        // 防作弊 2：防止重放攻击 (Duplicate Share)
        const shareKey = `${header}_${nonce}`;
        if (usedNonces.has(shareKey)) {
            return socket.emit('share_result', { success: false, message: 'Duplicate Share' });
        }

        // 防作弊 3：服务端哈希验证 (Fake Share Verification)
        const shareTarget = socket.shareTarget || currentJob.shareTarget;
        const isValid = verifyShare(header, nonce, shareTarget);
        if (!isValid) {
            console.warn(`[Anti-Cheat] 检测到非法份额提交! Miner: ${socket.minerAddress}`);
            return socket.emit('share_result', { success: false, message: 'Low Difficulty Share' });
        }

        // 记录该 Nonce 已使用
        usedNonces.add(shareKey);

        try {
            if (!bumpAccepted(ip) || isIpBanned(ip)) {
                socket.emit('share_result', { success: false, message: 'IP Banned' });
                return socket.disconnect(true);
            }

            // 如果哈希值达到了全网难度 (Real Block Found!)
            const isRealBlock = verifyShare(header, nonce, currentJob.target);
            
            if (isRealBlock) {
                console.log(`[Pool] 🏆 矿工 ${socket.minerAddress} 找到了真实区块!`);
                await rpc.call('submitblock', [/* data */]);
            }

            // 记录有效份额到 PPLNS 系统
            stats.recordMine(socket.minerAddress, socket.workerId, {
                difficulty: 1,
                isBlock: isRealBlock,
                height: currentJob.height,
                hash: crypto.createHash('sha256').update(header + nonce).digest('hex'),
                reward: config.pool.rewardPerBlock || 100,
                minerAddress: socket.minerAddress
            });

            if (vardiffEnabled && socket.vardiff) {
                const now = Date.now();
                socket.vardiff.accepted += 1;
                const elapsed = now - socket.vardiff.windowStart;
                const shouldAdjust = (now - socket.vardiff.lastAdjust) >= vardiffAdjustMs || elapsed >= vardiffAdjustMs;
                if (shouldAdjust) {
                    const expected = Math.max(1, Math.round((elapsed || vardiffAdjustMs) / vardiffTargetShareTimeMs));
                    let newDiff = socket.shareDifficulty;
                    if (socket.vardiff.accepted > expected * 2) newDiff = socket.shareDifficulty * 2;
                    else if (socket.vardiff.accepted < Math.max(1, Math.floor(expected / 2))) newDiff = Math.max(1, Math.floor(socket.shareDifficulty / 2));
                    newDiff = clampDifficulty(newDiff);

                    socket.vardiff.windowStart = now;
                    socket.vardiff.accepted = 0;
                    socket.vardiff.lastAdjust = now;

                    if (newDiff !== socket.shareDifficulty) {
                        socket.shareDifficulty = newDiff;
                        socket.shareTarget = getShareTargetForDifficulty(currentJob.shareTarget, socket.shareDifficulty);
                        socket.emit('mining_job', {
                            header: currentJob.header,
                            difficulty: socket.shareDifficulty,
                            height: currentJob.height,
                            shareTarget: socket.shareTarget
                        });
                    }
                }
            }

            // 如果是真实区块，全网广播
            if (isRealBlock) {
                io.to('stats_room').emit('new_block', {
                    height: currentJob.height,
                    miner: socket.minerAddress,
                    timestamp: Date.now()
                });
            }

            socket.emit('share_result', { 
                success: true, 
                message: isRealBlock ? 'Block Found!' : 'Share Accepted',
                isBlock: isRealBlock
            });
            
        } catch (err) {
            socket.emit('share_result', { success: false, error: err.message });
        }
    });

    socket.on('disconnect', () => {
        console.log(`[WS] 矿工断开: ${socket.id}`);
        const current = ipConnections.get(ip) || 0;
        if (current <= 1) ipConnections.delete(ip);
        else ipConnections.set(ip, current - 1);
    });
});

setInterval(() => {
    const now = Date.now();
    for (const [ip, until] of ipBans.entries()) {
        if (until <= now) ipBans.delete(ip);
    }
    for (const [ip, entry] of ipRates.entries()) {
        if (now - entry.windowStart > rateWindowMs * 6) ipRates.delete(ip);
    }
    for (const [ip, entry] of ipAccepted.entries()) {
        if (now - entry.windowStart > rateWindowMs * 6) ipAccepted.delete(ip);
    }
}, 60000);

// 每 3 秒广播一次全网统计
setInterval(() => {
    io.to('stats_room').emit('stats_update', stats.getStats());
}, 3000);

// ==================== HTTP API (保留兼容) ====================

app.use(express.static(path.join(__dirname, '../web')));

app.get('/api/stats', (req, res) => res.json(stats.getStats()));

app.get('/modern', (req, res) => res.sendFile(path.join(__dirname, '../web/modern_index.html')));
app.get('/modern-miner', (req, res) => res.sendFile(path.join(__dirname, '../web/modern_miner.html')));
app.get('/modern-stratum', (req, res) => res.sendFile(path.join(__dirname, '../web/modern_stratum.html')));
app.get('/modern-wallet', (req, res) => res.sendFile(path.join(__dirname, '../web/modern_wallet.html')));

app.get('/', (req, res) => res.redirect('/modern'));

// ==================== 启动服务 ====================

const PORT = process.env.PORT || config.pool.port || 4000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
    console.log(`\n🚀 DIBI8 Pool (WebSocket Enabled) running on ${HOST}:${PORT}\n`);
});
