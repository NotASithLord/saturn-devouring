import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the actual private vendored classes, not a second implementation of their
// timestamp arithmetic. Only GPU I/O and the monotonic clock are faked. No GPU
// timing, rendering performance, or browser compatibility is measured here.
const source = await readFile(new URL('./vendor/three.webgpu.module.js', import.meta.url), 'utf8');
function classSource(name) {
  const start = source.indexOf(`class ${name} `);
  assert.ok(start >= 0);
  const open = source.indexOf('{', start);
  let end = open + 1, depth = 1;
  while (depth) {
    assert.ok(end < source.length);
    const char = source[end++];
    if (char === '{') depth++;
    if (char === '}') depth--;
  }
  return source.slice(start, end);
}
const baseClass = classSource('TimestampQueryPool');
const gpuClass = classSource('WebGPUTimestampQueryPool');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  let clock = 1000;
  const logs = [], buffers = [];
  const descriptor = () => ({ reset() {} });
  const Pool = vm.runInNewContext(`${baseClass}\n${gpuClass}\nWebGPUTimestampQueryPool`, {
    performance: { now: () => clock },
    BigUint64Array,
    GPUBufferUsage: { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 },
    GPUMapMode: { READ: 1 },
    _querySetDescriptor$1: descriptor(), _bufferDescriptor$1: descriptor(), _commandEncoderDescriptor$1: {},
    submit: (device, command) => device.queue.submit([command]),
    error: (...args) => logs.push(args), warn: (...args) => logs.push(args), warnOnce: (...args) => logs.push(args),
  });
  const device = {
    submissions: 0,
    queue: { submit(commands) { device.submissions++; for (const command of commands) for (const execute of command) execute(); } },
    createQuerySet({ count }) {
      return { values: new BigUint64Array(count), destroyed: false, destroy() { this.destroyed = true; } };
    },
    createBuffer({ size, usage }) {
      const buffer = {
        bytes: new ArrayBuffer(size), usage, mapState: 'unmapped', maps: 0, unmaps: 0, destroyed: false,
        async mapAsync() {
          assert.equal(this.mapState, 'unmapped');
          this.mapState = 'pending'; this.maps++;
          clock += 4;
          if (this.gate) await this.gate.promise;
          if (this.rejectMap) { this.mapState = 'unmapped'; throw Error('Injected map failure'); }
          this.mapState = 'mapped';
        },
        getMappedRange(offset, size) {
          assert.equal(this.mapState, 'mapped');
          if (this.rejectRange) throw Error('Injected range failure');
          return this.bytes.slice(offset, offset + size);
        },
        unmap() { assert.equal(this.mapState, 'mapped'); this.unmaps++; this.mapState = 'unmapped'; },
        destroy() { assert.equal(this.mapState, 'unmapped'); this.destroyed = true; },
      };
      buffers.push(buffer); return buffer;
    },
    createCommandEncoder() {
      const commands = [];
      return {
        resolveQuerySet(query, first, count, target, offset) {
          commands.push(() => new BigUint64Array(target.bytes, offset, count).set(query.values.subarray(first, first + count)));
        },
        copyBufferToBuffer(from, fromOffset, to, toOffset, size) {
          commands.push(() => {
            assert.equal(to.mapState, 'unmapped', 'A result buffer cannot be reused during readback');
            new Uint8Array(to.bytes, toOffset, size).set(new Uint8Array(from.bytes, fromOffset, size));
          });
        },
        finish() { return commands; },
      };
    },
  };
  const pool = new Pool(device, 'render', 64);
  return {
    pool, device, buffers, logs,
    advance(ms) { clock += ms; },
    setClock(value) { clock = value; },
    add(uid, start, end) {
      const offset = pool.allocateQueriesForContext(uid);
      assert.notEqual(offset, null);
      pool.querySet.values[offset] = start; pool.querySet.values[offset + 1] = end;
      return offset;
    },
  };
}

let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`PASS ${name}`); }
const epoch = 1n << 63n;
function seedPrevious(pool) {
  pool.lastValue = 7;
  pool.frames = [9];
  pool.timestamps.set('previous:f9', 7);
}
function assertPrevious(pool) {
  assert.equal(pool.lastValue, 7);
  assert.deepEqual(Array.from(pool.frames), [9]);
  assert.deepEqual(Array.from(pool.timestamps, ([uid, duration]) => [uid, duration]), [['previous:f9', 7]]);
  assert.equal(pool.resultBuffer.mapState, 'unmapped');
  assert.equal(pool.pendingResolve, null);
}

await check('Valid multi-pass frames preserve integer subtraction at large counter epochs', async () => {
  const f = fixture();
  f.add('scene:f10', epoch, epoch + 1_000_000n);
  f.add('post:f10', epoch + 1_000_000n, epoch + 3_000_000n);
  f.add('scene:f11', epoch + 3_000_000n, epoch + 6_000_001n);
  f.advance(20);
  assert.equal(await f.pool.resolveQueriesAsync(), 3.000001);
  assert.equal(f.pool.getTimestamp('scene:f10'), 1);
  assert.equal(f.pool.getTimestamp('post:f10'), 2);
  assert.deepEqual(Array.from(f.pool.getTimestampFrames()), [10, 11]);
  assert.equal(f.pool.resultBuffer.unmaps, 1);
});

for (const [name, pairs] of [
  ['reversed counter pair', [[epoch + 2n, epoch + 1n]]],
  ['all-zero counters', [[0n, 0n]]],
  ['equal nonzero counters', [[epoch, epoch]]],
  ['impossible positive jump', [[epoch, epoch + 1_000_000_000_000n]]],
  ['impossible per-frame sum', [[epoch, epoch + 5_000_000n], [epoch + 5_000_000n, epoch + 10_000_000n]]],
]) await check(`Invalid ${name} retains the last valid public result and releases readback`, async () => {
  const f = fixture(); seedPrevious(f.pool);
  pairs.forEach(([start, end], index) => f.add(`pass${index}:f12`, start, end));
  assert.equal(await f.pool.resolveQueriesAsync(), 7);
  assertPrevious(f.pool);
  assert.equal(f.pool.resultBuffer.unmaps, 1);
  assert.equal(f.pool.currentQueryIndex, 0); assert.equal(f.pool.queryOffsets.size, 0);
});

await check('A valid prefix cannot partially publish a batch containing one invalid pair', async () => {
  const f = fixture(); seedPrevious(f.pool);
  f.add('valid:f12', epoch, epoch + 1_000_000n);
  f.add('invalid:f13', epoch + 2n, epoch + 1n);
  assert.equal(await f.pool.resolveQueriesAsync(), 7); assertPrevious(f.pool);
});

await check('Quantized zero passes are legal when their complete frame has positive duration', async () => {
  const f = fixture();
  f.add('empty:f12', 0n, 0n); f.add('scene:f12', 0n, 2_000_000n);
  assert.equal(await f.pool.resolveQueriesAsync(), 2);
  assert.equal(f.pool.getTimestamp('empty:f12'), 0);
  assert.equal(f.pool.getTimestamp('scene:f12'), 2);
});

await check('Any wholly zero frame rejects the batch, even if a later frame is positive', async () => {
  const f = fixture(); seedPrevious(f.pool);
  f.add('empty:f12', 0n, 0n); f.add('scene:f13', 0n, 2_000_000n);
  assert.equal(await f.pool.resolveQueriesAsync(), 7); assertPrevious(f.pool);
});

await check('The host envelope includes time before resolve, not just readback latency', async () => {
  const f = fixture();
  f.add('scene:f12', epoch, epoch + 20_000_000n);
  f.advance(30);
  assert.equal(await f.pool.resolveQueriesAsync(), 20);
  assert.equal(f.pool.resultBuffer.unmaps, 1);
});

await check('Counter epoch changes between valid batches do not invalidate elapsed durations', async () => {
  const f = fixture();
  f.add('scene:f12', epoch, epoch + 2_000_000n);
  assert.equal(await f.pool.resolveQueriesAsync(), 2);
  f.add('scene:f13', 1n, 3_000_001n);
  assert.equal(await f.pool.resolveQueriesAsync(), 3);
});

await check('Invalid host-clock envelopes do not publish a new timing', async () => {
  for (const time of [NaN, Infinity, 900]) {
    const f = fixture(); seedPrevious(f.pool);
    f.add('scene:f12', epoch, epoch + 1_000_000n); f.setClock(time);
    assert.equal(await f.pool.resolveQueriesAsync(), 7); assertPrevious(f.pool);
  }
});

await check('Pending resolution owns its readback while later query allocations remain queued', async () => {
  const f = fixture(), gate = deferred(); f.pool.resultBuffer.gate = gate;
  f.add('scene:f12', epoch, epoch + 1_000_000n);
  const first = f.pool.resolveQueriesAsync();
  assert.equal(f.pool.resultBuffer.mapState, 'pending');
  f.add('scene:f13', epoch + 1_000_000n, epoch + 3_000_000n);
  const second = f.pool.resolveQueriesAsync();
  assert.equal(f.device.submissions, 1);
  gate.resolve(); assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(f.pool.currentQueryIndex, 2);
  f.pool.resultBuffer.gate = null;
  assert.equal(await f.pool.resolveQueriesAsync(), 2);
  assert.equal(f.device.submissions, 2); assert.equal(f.pool.resultBuffer.unmaps, 2);
});

await check('An already-mapped buffer is neither stolen nor unmapped by a skipped resolve', async () => {
  const f = fixture(); seedPrevious(f.pool);
  f.add('scene:f12', epoch, epoch + 1_000_000n);
  f.pool.resultBuffer.mapState = 'mapped';
  assert.equal(await f.pool.resolveQueriesAsync(), 7);
  assert.equal(f.pool.resultBuffer.mapState, 'mapped'); assert.equal(f.pool.resultBuffer.unmaps, 0);
  assert.equal(f.pool.currentQueryIndex, 2);
  f.pool.resultBuffer.mapState = 'unmapped';
  assert.equal(await f.pool.resolveQueriesAsync(), 1);
});

for (const fault of ['rejectMap', 'rejectRange']) await check(`${fault} preserves ownership and permits a later valid resolve`, async () => {
  const f = fixture(); seedPrevious(f.pool);
  f.add('scene:f12', epoch, epoch + 1_000_000n); f.pool.resultBuffer[fault] = true;
  assert.equal(await f.pool.resolveQueriesAsync(), 7); assertPrevious(f.pool);
  assert.equal(f.logs.length, 1);
  f.pool.resultBuffer[fault] = false;
  f.add('scene:f13', epoch, epoch + 2_000_000n);
  assert.equal(await f.pool.resolveQueriesAsync(), 2);
});

await check('Disposal during pending readback waits, unmaps once, and never publishes that batch', async () => {
  const f = fixture(), gate = deferred(), query = f.pool.querySet, result = f.pool.resultBuffer;
  seedPrevious(f.pool); result.gate = gate;
  f.add('scene:f12', epoch, epoch + 1_000_000n);
  const reading = f.pool.resolveQueriesAsync(), disposing = f.pool.dispose();
  assert.equal(query.destroyed, false); assert.equal(result.destroyed, false);
  gate.resolve(); assert.equal(await reading, 7); await disposing;
  assert.equal(result.unmaps, 1); assert.equal(query.destroyed, true);
  assert.ok(f.buffers.every(buffer => buffer.destroyed));
  assert.equal(f.pool.lastValue, 7);
});

await check('Timestamp tracking remains opt-in and disabled pools perform no GPU work', async () => {
  const f = fixture(); f.pool.trackTimestamp = false;
  assert.equal(f.pool.allocateQueriesForContext('scene:f12'), null);
  assert.equal(await f.pool.resolveQueriesAsync(), 0); assert.equal(f.device.submissions, 0);
  assert.match(source, /this\.trackTimestamp = \( parameters\.trackTimestamp === true \);/);
  const runtime = await readFile(new URL('./runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(runtime, /trackTimestamp\s*:/);
});

console.log(`${passed}/${passed} actual vendor timestamp-resolver host checks passed; no browser or GPU execution performed.`);
