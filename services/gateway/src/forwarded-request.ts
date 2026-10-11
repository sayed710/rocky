import type { Redis } from 'ioredis';

/** Redis is the clock and serialization point; gateway wall clocks are irrelevant. */
export const ENQUEUE_REQUEST = `-- r03-enqueue
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local now = redis.call('TIME')
local deadline = now[1] * 1000 + math.floor(now[2] / 1000) + tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'status', 'queued', 'deadline', deadline, 'payload', ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) + tonumber(ARGV[3]))
-- Remove bounded stale heads even if their forwarder died before cancellation.
-- Active traffic must not keep abandoned envelopes alive indefinitely.
for i = 1, 128 do
  local head = redis.call('LINDEX', KEYS[2], 0)
  if not head then break end
  local decoded, envelope = pcall(cjson.decode, head)
  if decoded and type(envelope) == 'table' and type(envelope.requestId) == 'string' then
    local key = 'game:request:' .. envelope.requestId
    local status = redis.call('HGET', key, 'status')
    local expires = tonumber(redis.call('HGET', key, 'deadline')) or 0
    if status == 'queued' and expires > deadline - tonumber(ARGV[2]) then break end
    if status == 'queued' then redis.call('HSET', key, 'status', 'expired') end
  end
  redis.call('LPOP', KEYS[2])
end
redis.call('RPUSH', KEYS[2], ARGV[1])
local retention = tonumber(ARGV[2]) + tonumber(ARGV[3])
if redis.call('PTTL', KEYS[2]) < retention then redis.call('PEXPIRE', KEYS[2], retention) end
return 1`;

export const START_REQUEST = `-- r03-start
if redis.call('HGET', KEYS[1], 'payload') ~= ARGV[1] then return 'missing' end
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'queued' then return status or 'expired' end
local now = redis.call('TIME')
local time = now[1] * 1000 + math.floor(now[2] / 1000)
if time >= tonumber(redis.call('HGET', KEYS[1], 'deadline')) then
  redis.call('HSET', KEYS[1], 'status', 'expired')
  return 'expired'
end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  -- An old consumer must hand unstarted work to the new owner, with the
  -- same identity/deadline. It cannot steal or replay admitted execution.
  redis.call('RPUSH', KEYS[3], ARGV[1])
  local retention = tonumber(redis.call('HGET', KEYS[1], 'deadline')) - time + tonumber(ARGV[4])
  if redis.call('PTTL', KEYS[3]) < retention then redis.call('PEXPIRE', KEYS[3], retention) end
  return 'not_owner'
end
redis.call('HSET', KEYS[1], 'status', 'started', 'executor', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 'admitted'`;

/** Only the admitting executor may record the result; missing state is never recreated. */
export const FINISH_REQUEST = `-- r03-finish
if redis.call('HGET', KEYS[1], 'status') ~= 'started' or
   redis.call('HGET', KEYS[1], 'executor') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'done', 'result', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1`;

/** Cancel only unstarted work. Execution and cancellation cannot both win. */
export const SETTLE_REQUEST = `-- r03-settle
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'done' then return redis.call('HGET', KEYS[1], 'result') end
if status == 'queued' then
  redis.call('HSET', KEYS[1], 'status', 'expired')
  redis.call('LREM', KEYS[2], 0, ARGV[1])
  return 'expired'
end
return status or 'unknown'`;

/** Atomically publish and expire, including when the receiver has gone away. */
export const RESPOND_REQUEST = `-- r03-respond
redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

// Started records may expire while execution is stalled. An envelope alone can
// never recreate one, so retention expiry loses reconciliation, not dedup safety.
export const REQUEST_RETENTION_MS = 30_000;
export const requestKey = (requestId: string): string => `game:request:${requestId}`;

export async function respond(redis: Redis, key: string, result: string): Promise<void> {
  await redis.eval(RESPOND_REQUEST, 1, key, result, REQUEST_RETENTION_MS);
}
