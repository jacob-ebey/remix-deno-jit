import { useCallback, useState } from "react";
import { json, type LoaderArgs } from "@remix-run/deno";
import { Link, Outlet, useLoaderData } from "@remix-run/react";

import { useReward } from "react-rewards";
import { throttle } from "~/utils.ts";

export function loader({}: LoaderArgs) {
  return json({ message: "About Page!" });
}

export default function Index() {
  const { message } = useLoaderData<typeof loader>();
  const [count, setCount] = useState(0);

  const { reward } = useReward("rewardId", "balloons");
  const debouncedReward = useCallback(throttle(reward, 1000), [reward]);

  return (
    <main>
      <h1>{message}</h1>
      <p>
        <Link to="/">Home</Link>
      </p>
      <p>
        <button
          onClick={(event) => {
            setCount(count + 1);
            debouncedReward();
          }}
        >
          <span id="rewardId" />
          Increment
        </button>{" "}
        <span>Count: {count}</span>
      </p>
      <Outlet />
    </main>
  );
}
