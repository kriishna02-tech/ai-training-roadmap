-- KEYS[1]: bucket; ARGV: capacity, refill/second, cost.
-- Redis supplies time so workers need no synchronized application clocks.
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + tonumber(clock[2]) / 1000
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
local tokens = tonumber(state[1]) or capacity
local updated = tonumber(state[2]) or now
-- Preserve the last timestamp if the wall clock moves backwards.
now = math.max(now, updated)
tokens = math.min(capacity, tokens + (now - updated) * rate / 1000)
local allowed = 0
local retry_ms = 0
if tokens >= cost then
    tokens = tokens - cost
    allowed = 1
else
    retry_ms = math.ceil((cost - tokens) / rate * 1000)
end
local reset_ms = math.ceil((capacity - tokens) / rate * 1000)
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_ms', now)
-- Retain state at least until a complete refill; idle buckets disappear.
redis.call('PEXPIRE', KEYS[1], math.max(1000, math.ceil(capacity / rate * 1000)))
return {allowed, math.floor(tokens), retry_ms, reset_ms}
