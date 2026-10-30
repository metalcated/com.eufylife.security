'use strict';

// Account-free check against the pinned SDK, intended for Docker --network none.
// Real workers and UDP sockets are used; all cloud calls terminate in this fixture.
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { Camera, DeviceType, P2PConnectionType } = require('eufy-security-client');
const CameraP2PSession = require('../lib/helpers/camera-p2p-session.helper');
const workers = [];
const sessions = [];
const deadline = async (promise, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), 12000);
    })]); } finally { clearTimeout(timer); }
};
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

class ObservedWorker extends Worker {
    constructor(filename, options) {
        // Observe real socket binding without adding a production diagnostic API.
        super(`const {parentPort,workerData}=require('node:worker_threads');
            const dgram=require('node:dgram'); const create=dgram.createSocket;
            dgram.createSocket=function(...args) { const socket=create.apply(this,args);
                socket.once('listening',()=>parentPort.postMessage({type:'lifecycle-test-bound'})); return socket; };
            if(workerData.lifecycleTestGateway) {
                const path=require('node:path');
                const build=path.dirname(require.resolve('eufy-security-client'));
                const {P2PClientProtocol}=require(path.join(build,'p2p/session.js'));
                const {P2PDataType,CommandType,EncryptionType}=require(path.join(build,'p2p/types.js'));
                // Inject the actual SDK control-message handler, without a
                // device, UDP input, cloud account, or production code change.
                P2PClientProtocol.prototype.connect=function() {
                    this.sendQueuedMessage=()=>parentPort.postMessage({type:'lifecycle-test-gateway-complete',
                        fallbackReady:this.encryption===EncryptionType.LEVEL_1 && Buffer.isBuffer(this.p2pKey) && this.p2pKey.length>0});
                    const data=Buffer.alloc(20); data.writeUInt16LE(7,0);
                    this.handleData({dataType:P2PDataType.CONTROL,commandId:CommandType.CMD_GATEWAYINFO,
                        signCode:0,type:0,seqNo:0,channel:255,bytesToRead:data.length,data});
                    return Promise.resolve();
                };
            }
            require(${JSON.stringify(filename)});`, { ...options, eval: true });
        this.bound = deferred();
        this.gateway = deferred();
        this.on('message', message => {
            if (message?.type === 'lifecycle-test-bound') this.bound.resolve();
            if (message?.type === 'lifecycle-test-gateway-complete') this.gateway.resolve(message);
        });
        workers.push(this);
    }
}

class GatewayWorker extends ObservedWorker {
    constructor(filename, options) {
        super(filename, { ...options, workerData: { ...options.workerData, lifecycleTestGateway: true } });
    }
}

function candidate(label, { bind = false, gateway = false } = {}) {
    const requestSeen = deferred();
    const cipherSeen = deferred();
    const cipherCalls = [];
    const reply = deferred();
    const base = 'FIXTURE_HOMEBASE';
    const serial = `FIXTURE_CAMERA_${label}`;
    const rawDevice = { device_sn: serial, station_sn: base, device_channel: label === 'B' ? 1 : 0,
        device_type: DeviceType.CAMERA2, device_name: label, params: [], main_sw_version: '4.0.0.0' };
    const rawStation = { station_sn: base, device_type: DeviceType.HB3, station_name: 'Fixture',
        p2p_did: 'FIXTURE_DID', app_conn: '', main_sw_version: '3.3.0.0', params: [],
        member: { admin_user_id: 'FIXTURE_USER' }, devices: [rawDevice] };
    const api = {
        isConnected: () => true,
        getCipher: async (id, user) => {
            assert.equal(gateway, true, 'a non-handshake fixture requested a cipher');
            assert.equal(id, 7);
            assert.equal(user, rawStation.member.admin_user_id);
            cipherCalls.push({ id, user });
            cipherSeen.resolve();
            // A malformed fixture key must take the SDK's supported Level 1
            // fallback after the real getCipher RPC returns. No real key exists.
            return { cipher_id: id, user_id: user, private_key: 'fixture-invalid-private-key' };
        },
        request: async request => {
            assert.equal(request.endpoint, 'v1/app/equipment/get_dsk_keys');
            assert.deepEqual(request.data.station_sns, [base]);
            requestSeen.resolve();
            if (bind) return { status: 200, data: { code: 0, data: { dsk_keys: [
                { station_sn: base, dsk_key: 'fixture-key', expiration: Math.floor(Date.now() / 1000) + 3600 }
            ] } } };
            return reply.promise;
        },
    };
    const client = { getApi: () => api, getConfig: () => ({ deviceConfig: { simultaneousDetections: true },
        stationIPAddresses: { [base]: '127.0.0.1' } }) };
    const homeyDevice = { EufyDevice: new Camera(api, rawDevice, {}),
        EufyStation: { getRawStation: () => rawStation, getConnectionType: () => P2PConnectionType.ONLY_LOCAL } };
    const session = new CameraP2PSession({ client, homeyDevice, WorkerClass: gateway ? GatewayWorker : ObservedWorker,
        onStream: () => assert.fail('Offline fixture must never produce camera footage'),
        startupTimeoutMs: 15000, shutdownTimeoutMs: 100 });
    sessions.push(session);
    const started = session.start();
    started.catch(() => {});
    return { session, started, requestSeen, reply, cipherSeen, cipherCalls };
}

async function main() {
    const a = candidate('A');
    const b = candidate('B');
    await deadline(Promise.all([a.requestSeen.promise, b.requestSeen.promise]), 'SDK did not reach owned key lookup');
    assert.equal(workers.length, 2);
    assert.notEqual(workers[0].threadId, workers[1].threadId);
    await a.session.close();
    assert.equal(workers[0].threadId, -1, 'close resolved before its real worker exited');
    assert.ok(workers[1].threadId > 0, 'closing A terminated B');
    a.reply.resolve({ status: 200, data: { code: 0, data: { dsk_keys: [] } } });
    await assert.rejects(a.started, /cancelled/);
    await b.session.close();
    b.reply.resolve({ status: 200, data: { code: 0, data: { dsk_keys: [] } } });
    assert.equal(workers[1].threadId, -1);
    await assert.rejects(b.started, /cancelled/);

    const bound = candidate('BOUND', { bind: true });
    const worker = workers.at(-1);
    await deadline(worker.bound.promise, 'Pinned SDK did not bind its owned UDP socket');
    await bound.session.close();
    assert.equal(worker.threadId, -1, 'bound SDK socket outlived close');
    await assert.rejects(bound.started, /cancelled/);
    assert.deepEqual(await bound.session.close(), { stopConfirmed: false }, 'repeated close changed the result');

    const gateway = candidate('GATEWAY', { gateway: true });
    const handshakeWorker = workers.at(-1);
    await deadline(gateway.cipherSeen.promise, 'Actual SDK gateway-info handling did not request its own cipher');
    const handshake = await deadline(handshakeWorker.gateway.promise, 'Actual SDK gateway-info handling did not finish its cipher fallback');
    assert.equal(handshake.fallbackReady, true, 'the SDK handshake did not complete its fallback key setup');
    assert.deepEqual(gateway.cipherCalls, [{ id: 7, user: 'FIXTURE_USER' }]);
    await gateway.session.close();
    assert.equal(handshakeWorker.threadId, -1, 'the handshake worker outlived close');
    await assert.rejects(gateway.started, /cancelled/);
    console.log('Pinned SDK lifecycle verified: independent real workers, pending lookup cancellation, late reply ignored, bound UDP worker terminated, repeated close, and actual gateway-info getCipher RPC/fallback.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
    await Promise.allSettled(sessions.map(session => session.close()));
    await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()));
});
