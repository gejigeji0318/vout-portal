import { Text, type TextProps } from '@mantine/core';

/**
 * 管理者が書いた本文を表示する。HTML としては解釈せず、改行だけを生かす
 * （本文に <script> などが書かれても、そのまま文字として表示される）
 */
export function BodyText({ children, ...props }: TextProps & { children: string }) {
  return <Text {...props} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.9, ...(props.style as object) }}>{children}</Text>;
}
