import { Redis } from 'ioredis';
import type { Config } from '../config.js';

export type RedisClient = Redis;

export function createRedis(cfg: Config): RedisClient {
  return new Redis(cfg.redis.url, {
    keyPrefix: cfg.redis.keyPrefix,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 5000,
    lazyConnect: false,
  });
}
