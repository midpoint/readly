/** 聚类 Worker 工厂:单独成模块,store 从这里导入以便测试整体 mock(vi.mock)。 */
export function createAnalysisWorker(): Worker {
  return new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
}
