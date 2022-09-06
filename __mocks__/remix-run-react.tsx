import sinon from "https://esm.sh/sinon@14.0.0";

import * as ReactRouter from "https://esm.sh/react-router-dom@6.3.0?deps=react@18.2.0,react-dom@18.2.0";
import * as React from "react";
import * as RemixReact from "@remix-run/react-original";

export * from "@remix-run/react-original";

const RouteTestContext = React.createContext({ path: "/" });
export const TestProvider = ({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) => (
  <RouteTestContext.Provider value={{ path }}>
    {children}
  </RouteTestContext.Provider>
);

const stub = sinon.stub({
  useLoaderData: RemixReact.useLoaderData,
});
export const useLoaderData = stub.useLoaderData;

export const Link = ({
  to,
  reloadDocument,
  replace,
  state,
  prefetch,
  children,
  ...rest
}: React.ComponentProps<typeof RemixReact.Link>) => {
  const options = React.useContext(RouteTestContext);
  const href = ReactRouter.createPath(
    ReactRouter.resolvePath(to, options.path),
  );

  return (
    <a
      {...rest}
      href={href}
      test-reloaddocument={reloadDocument ? "true" : undefined}
      test-replace={replace ? "true" : undefined}
      test-state={state ? JSON.stringify(state) : undefined}
      test-prefetch={prefetch}
    >
      {children}
    </a>
  );
};
