export const DIFFICULTIES = {
  easy: { label: '简单', threshold: 0.3, minInterval: 0.45 },
  normal: { label: '普通', threshold: 0.3, minInterval: 0.2 },
  hard: { label: '困难', threshold: 0.22, minInterval: 0.12 },
} as const;

export type Difficulty = keyof typeof DIFFICULTIES;
