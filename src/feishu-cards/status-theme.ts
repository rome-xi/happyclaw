import type { CardStatus } from './types.js';

/** Status-driven header theme. Must use Feishu v2 color enums — never CSS hex. */
export interface StatusTheme {
  template: 'blue' | 'violet' | 'orange' | 'red';
  tagColor: 'blue' | 'violet' | 'orange' | 'red';
  tagText: string;
  /** Feishu standard_icon token rendered in header.icon (left of the title). */
  iconToken: string;
  /** Icon accent color — picked to match the header template. */
  iconColor: 'blue' | 'violet' | 'orange' | 'red' | 'white';
}

const STATUS_THEMES: Record<CardStatus, StatusTheme> = {
  running: {
    template: 'blue',
    tagColor: 'blue',
    tagText: '生成中',
    iconToken: 'loading_outlined',
    iconColor: 'white',
  },
  done: {
    template: 'violet',
    tagColor: 'violet',
    tagText: '完成',
    iconToken: 'check-circle_filled',
    iconColor: 'white',
  },
  warning: {
    template: 'orange',
    tagColor: 'orange',
    tagText: '部分成功',
    iconToken: 'warning_filled',
    iconColor: 'white',
  },
  error: {
    template: 'red',
    tagColor: 'red',
    tagText: '失败',
    iconToken: 'close-circle_filled',
    iconColor: 'white',
  },
};

export function resolveStatusTheme(status: CardStatus): StatusTheme {
  return STATUS_THEMES[status];
}
