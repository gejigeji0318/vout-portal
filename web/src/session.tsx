import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrfToken, type Me } from './api';

interface SessionValue { me: Me | null; reload: () => Promise<void> }
const Ctx = createContext<SessionValue>({ me: null, reload: async () => {} });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const reload = useCallback(async () => {
    const m = await api<Me>('GET', '/api/me').catch(() => ({ loggedIn: false }) as Me);
    setCsrfToken(m.csrfToken ?? null);
    setMe(m);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return <Ctx.Provider value={{ me, reload }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
