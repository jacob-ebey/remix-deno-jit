import sinon from "https://esm.sh/sinon@14.0.0";

import { type ComponentProps } from "react";
import * as RemixReact from "@remix-run/react-original";
import * as ReactRouter from "https://esm.sh/react-router-dom@6.3.0?deps=react@18.2.0,react-dom@18.2.0";

import { useTestContext } from "../app/test.utils.tsx";

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
}: ComponentProps<typeof RemixReact.Link>) => {
  const options = useTestContext();
  const href = ReactRouter.createPath(
    ReactRouter.resolvePath(to, options.path)
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
