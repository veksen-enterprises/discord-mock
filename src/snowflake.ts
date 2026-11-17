const DISCORD_EPOCH = 1420070400000n;
let increment = 0n;

/** A real-shaped snowflake: timestamp in the high bits, so ordering by id is ordering by time. */
export function snowflake(now = Date.now()): string {
  increment = (increment + 1n) & 0xfffn;
  return (((BigInt(now) - DISCORD_EPOCH) << 22n) | increment).toString();
}
