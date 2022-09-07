import { createContext, useContext, type ReactNode } from "react";

const RouteTestContext = createContext({ path: "/" });

export function useTestContext() {
  return useContext(RouteTestContext);
}

export function TestProvider({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  return (
    <RouteTestContext.Provider value={{ path }}>
      {children}
    </RouteTestContext.Provider>
  );
}
