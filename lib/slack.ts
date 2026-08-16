import "server-only";

export type SlackPostResult =
  | { success: true }
  | { success: false; error: string };

function getSlackError(value: unknown) {
  if (typeof value === "string" && /^[a-z0-9_-]{1,100}$/i.test(value)) {
    return value;
  }

  return "unknown_error";
}

export async function postSlackMessage(text: string): Promise<SlackPostResult> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!botToken || !channelId) {
    return { success: false, error: "not_configured" };
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: channelId, text }),
      cache: "no-store",
    });
    const result = (await response.json()) as {
      ok?: unknown;
      error?: unknown;
    };

    if (!response.ok || result.ok !== true) {
      return { success: false, error: getSlackError(result.error) };
    }

    return { success: true };
  } catch {
    return { success: false, error: "request_failed" };
  }
}
