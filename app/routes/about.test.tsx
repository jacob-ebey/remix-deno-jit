import * as React from "react";
import { type LoaderArgs, json } from "@remix-run/deno";
import { Link, useLoaderData } from "@remix-run/react";

export function loader({}: LoaderArgs) {
  return json({ message: "Nested Page!" });
}

export default function Index() {
  const { message } = useLoaderData<typeof loader>();
  const [count, setCount] = React.useState(0);

  return (
    <div>
      <h1>{message}</h1>
      <p>
        <Link to="/">Nested</Link>
      </p>
      <p>
        <button onClick={() => setCount(count + 1)}>Increment</button>{" "}
        <span>Count: {count}</span>
      </p>
    </div>
  );
}
