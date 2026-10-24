import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEMO_STAFF } from '../../shared/domain';
import { setApiStaffId } from './api';

interface StaffContextValue {
  staffId: string;
  setStaffId: (id: string) => void;
}

const StaffContext = createContext<StaffContextValue | null>(null);
const KEY = 'careroute.demoStaffId';

function initialStaff(): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && DEMO_STAFF.some((s) => s.id === stored)) return stored;
  } catch {
    /* storage unavailable */
  }
  return DEMO_STAFF[0].id;
}

/** Demo staff identity (sent as a header). This is NOT authentication. */
export function StaffProvider({ children }: { children: ReactNode }) {
  const [staffId, setStaffIdState] = useState(initialStaff);
  setApiStaffId(staffId);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, staffId);
    } catch {
      /* ignore */
    }
  }, [staffId]);
  return <StaffContext.Provider value={{ staffId, setStaffId: setStaffIdState }}>{children}</StaffContext.Provider>;
}

export function useStaff(): StaffContextValue {
  const ctx = useContext(StaffContext);
  if (!ctx) throw new Error('useStaff must be used inside StaffProvider');
  return ctx;
}
