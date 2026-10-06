/** 根据 router1/R1 形式的起始名称生成不与实验已有设备冲突的名称。 */
export function plan_runtime_node_names(
  seed: string, count: number, occupied: readonly string[]
): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error('BATCH_COUNT_INVALID：一次只能创建 1–20 台设备。');
  }
  const trimmed = seed.trim();
  const match = /^([A-Za-z][A-Za-z0-9-]*?)(\d+)$/.exec(trimmed);
  const prefix = match ? match[1] : trimmed;
  let index = match ? Number(match[2]) : 1;
  if (!/^[A-Za-z][A-Za-z0-9-]{0,52}$/.test(prefix) || !Number.isSafeInteger(index) || index < 1) {
    throw new Error('NODE_NAME_INVALID：节点名请填写 router1、switch1 或 R1 等字母加序号。');
  }
  const used = new Set(occupied.map((value) => value.toLowerCase()));
  const names: string[] = [];
  while (names.length < count) {
    const name = `${prefix}${index++}`;
    if (name.length > 63) {
      throw new Error('NODE_NAME_INVALID：递增后的节点名称超过 63 字符，请缩短前缀。');
    }
    if (!used.has(name.toLowerCase())) {
      names.push(name);
      used.add(name.toLowerCase());
    }
  }
  return names;
}
