import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get, post, setToken, getToken, setUnauthorizedHandler } from './api.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: !!getToken(), user: null, teams: [] });

  const refresh = useCallback(async () => {
    try {
      const { user, memberships } = await get('/auth/me');
      const teams = memberships.map((m) => ({ id: m.teamId, name: m.teamName, role: m.role }));
      setState({ loading: false, user, teams });
    } catch {
      setToken(null);
      setState({ loading: false, user: null, teams: [] });
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setState({ loading: false, user: null, teams: [] });
    });
    if (getToken()) refresh();
  }, [refresh]);

  const authenticate = async (path, payload) => {
    const { token } = await post(path, payload);
    setToken(token);
    await refresh();
  };

  const value = {
    ...state,
    refresh,
    login: (email, password) => authenticate('/auth/login', { email, password }),
    register: (name, email, password) => authenticate('/auth/register', { name, email, password }),
    logout: () => {
      setToken(null);
      setState({ loading: false, user: null, teams: [] });
    },
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
