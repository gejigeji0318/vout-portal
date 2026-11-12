import { createTheme, type MantineColorsTuple } from '@mantine/core';

// 画面ラフと同じ配色：操作の青 #2148B8、文字 #1A1D23、背景 #F5F6F8
const actionBlue: MantineColorsTuple = [
  '#edf1fc', '#d8e0f7', '#adc0ee', '#809de5', '#5b80dd', '#436dd8', '#3563d6', '#2148b8', '#1b3d9e', '#143083',
];

export const theme = createTheme({
  primaryColor: 'action',
  primaryShade: 7,
  colors: { action: actionBlue },
  fontFamily: '"Noto Sans JP Variable", "Hiragino Sans", "Yu Gothic UI", sans-serif',
  headings: { fontFamily: '"Noto Sans JP Variable", "Hiragino Sans", "Yu Gothic UI", sans-serif', fontWeight: '700' },
  defaultRadius: 'md',
  black: '#1A1D23',
});
