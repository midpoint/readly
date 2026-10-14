/// <reference lib="webworker" />
import type { KeywordRule } from "@readly/shared";
import { clusterByTfIdf, ClusterCancelledError, type ClusterInput } from "./cluster";
import { matchDocs, type MatchDoc } from "./keywords";

interface ClusterMsg {
  type: "cluster";
  requestId: number;
  items: ClusterInput[];
  threshold: number;
}

interface KeywordsMsg {
  type: "keywords";
  requestId: number;
  docs: MatchDoc[];
  rules: KeywordRule[];
}

let currentRequestId = 0;

self.onmessage = (e: MessageEvent<ClusterMsg | KeywordsMsg | { type: "cancel"; requestId: number }>) => {
  const data = e.data;
  if (data.type === "cancel") {
    if (data.requestId === currentRequestId) currentRequestId = 0;
    return;
  }
  if (data.type === "keywords") {
    // 计算同步完成(无 progress);沿用 requestId 丢弃机制:被 cancel 置零后不再回传
    currentRequestId = data.requestId;
    try {
      const result = matchDocs(data.docs, data.rules);
      if (currentRequestId !== data.requestId) return;
      (self as unknown as Worker).postMessage({ type: "keywordsResult", requestId: data.requestId, result });
    } catch {
      (self as unknown as Worker).postMessage({ type: "error", requestId: data.requestId });
    }
    return;
  }
  if (data.type === "cluster") {
    currentRequestId = data.requestId;
    try {
      const groups = clusterByTfIdf(data.items, data.threshold, (ratio) => {
        if (currentRequestId !== data.requestId) throw new ClusterCancelledError();
        (self as unknown as Worker).postMessage({ type: "progress", requestId: data.requestId, ratio });
      });
      if (currentRequestId !== data.requestId) return;
      (self as unknown as Worker).postMessage({ type: "result", requestId: data.requestId, groups });
    } catch (err) {
      if (err instanceof ClusterCancelledError) {
        (self as unknown as Worker).postMessage({ type: "cancelled", requestId: data.requestId });
      } else {
        (self as unknown as Worker).postMessage({ type: "error", requestId: data.requestId });
      }
    }
  }
};
