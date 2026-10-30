import { createContext, useContext, type ReactNode } from 'react';
const Enabled = createContext(false),
  Control = createContext<((enabled: boolean) => void) | undefined>(undefined);
export const useMathEnabled = (override?: boolean) => {
  const value = useContext(Enabled);
  return override ?? value;
};
export const useMathControl = () => useContext(Control);
export function MathScope({
  enabled,
  onChange,
  children,
}: {
  enabled: boolean;
  onChange?: (enabled: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Enabled.Provider value={enabled}>
      <Control.Provider value={onChange}>{children}</Control.Provider>
    </Enabled.Provider>
  );
}
