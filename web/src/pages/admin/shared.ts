import { notifications } from '@mantine/notifications';
import { ApiError } from '../../api';

export const fail = (e: unknown) =>
  notifications.show({ color: 'red', title: 'できませんでした', message: e instanceof ApiError ? e.message : '通信に失敗しました' });
export const done = (message: string) => notifications.show({ color: 'green', message });

export interface Team { id: string; name: string | null; coaches: number; players: number }
export interface Tournament {
  id: string; name: string; phase: string; period_start: string; period_end: string; team_count: number;
  scrim_start: string | null; scrim_end: string | null; schedule_deadline: string | null;
}
