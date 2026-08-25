/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useReducer, type ReactNode, useEffect } from 'react';
import type { AuthState } from '../types';
import { authService } from '../services/api';
import { discardLegacyAdminToken } from '../services/admin-session';

// Context for auth state and dispatch
const AuthStateContext = createContext<AuthState | null>(null);
const AuthDispatchContext = createContext<React.Dispatch<AuthAction> | null>(null);

// Define action types for the reducer
type AuthAction =
  | { type: 'LOGIN_START' }
  | { type: 'LOGIN_SUCCESS' }
  | { type: 'LOGIN_FAILURE'; payload: string }
  | { type: 'LOGOUT' }
  | { type: 'RESTORE_SESSION' }
  | { type: 'CLEAR_ERROR' };

// Initial state - simplified without user
const initialState: AuthState = {
  isAuthenticated: false,
  isLoading: true,
  error: null,
};

// Auth reducer function
function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'LOGIN_START':
      return {
        ...state,
        isLoading: true,
        error: null,
      };

    case 'LOGIN_SUCCESS':
      return {
        ...state,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      };

    case 'LOGIN_FAILURE':
      return {
        ...state,
        isAuthenticated: false,
        isLoading: false,
        error: action.payload,
      };

    case 'LOGOUT':
      return {
        ...state,
        isAuthenticated: false,
        isLoading: false,
        error: null,
      };

    case 'RESTORE_SESSION':
      return {
        ...state,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      };

    case 'CLEAR_ERROR':
      return {
        ...state,
        error: null,
      };

    default:
      throw new Error('Unknown action: ' + (action as AuthAction).type);
  }
}

// AuthProvider component
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, initialState);

  // Restore session on mount
  useEffect(() => {
    discardLegacyAdminToken();
    authService
      .validate()
      .then(() => dispatch({ type: 'RESTORE_SESSION' }))
      .catch(() => dispatch({ type: 'LOGOUT' }));
  }, []);

  return (
    <AuthStateContext.Provider value={state}>
      <AuthDispatchContext.Provider value={dispatch}>
        {children}
      </AuthDispatchContext.Provider>
    </AuthStateContext.Provider>
  );
}

// Custom hooks to use the contexts
export function useAuthState() {
  const context = useContext(AuthStateContext);
  if (context === null) {
    throw new Error('useAuthState must be used within AuthProvider');
  }
  return context;
}

export function useAuthDispatch() {
  const context = useContext(AuthDispatchContext);
  if (context === null) {
    throw new Error('useAuthDispatch must be used within AuthProvider');
  }
  return context;
}

// High-level custom hook that provides auth actions
export function useAuth() {
  const state = useAuthState();
  const dispatch = useAuthDispatch();

  const login = async (password: string) => {
    dispatch({ type: 'LOGIN_START' });
    try {
      await authService.login(password);
      dispatch({ type: 'LOGIN_SUCCESS' });
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Login failed';
      dispatch({ type: 'LOGIN_FAILURE', payload: errorMessage });
      return { success: false, error: errorMessage };
    }
  };

  // Logout function
  const logout = async () => {
    try {
      await authService.logout();
    } catch {
      // Ignore logout errors
    }
    dispatch({ type: 'LOGOUT' });
  };

  const logoutAll = async () => {
    try {
      await authService.logoutAll();
    } finally {
      dispatch({ type: 'LOGOUT' });
    }
  };

  // Clear error function
  const clearError = () => {
    dispatch({ type: 'CLEAR_ERROR' });
  };

  return {
    ...state,
    login,
    logout,
    logoutAll,
    clearError,
  };
}
