import { assertEquals } from "https://deno.land/std@0.154.0/testing/asserts.ts";
import TestRenderer from "react-test-renderer";

import { TestProvider, useLoaderData } from "@remix-run/react";

import Component, { loader } from "../index.tsx";

Deno.test("loader returns message", async () => {
  const response = await loader({
    request: new Request("https://.../"),
    params: {},
    context: {},
  });
  const json = await response.json();

  assertEquals(json.message, "Hello from Remix on Deno!");
});

Deno.test("renders message", () => {
  const message = "Hello from the test!";
  useLoaderData.returns({
    message,
  } as never);
  const renderer = TestRenderer.create(
    <TestProvider path="/">
      <Component />
    </TestProvider>,
  );
  renderer.root.find((n) => n.children?.[0] === message);
  renderer.root.find((n) => n.type === "a" && n.props.href === "/about");
});
