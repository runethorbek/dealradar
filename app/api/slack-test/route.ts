export const dynamic = "force-dynamic";

const testMessage = "DealRadar Slack integration is working.";

function getSlackError(value: unknown) {
  if (
    typeof value === "string" &&
    /^[a-z0-9_-]{1,100}$/i.test(value)
  ) {
    return value;
  }

  return "unknown_error";
}

export async function POST() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  if (!botToken || !channelId) {
    return Response.json(
      {
        success: false,
        error: "Slack is not configured on the server.",
      },
      { status: 500 },
    );
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: channelId,
        text: testMessage,
      }),
      cache: "no-store",
    });
    const result = (await response.json()) as {
      ok?: unknown;
      error?: unknown;
    };

    if (!response.ok || result.ok !== true) {
      return Response.json(
        {
          success: false,
          error: `Slack rejected the message: ${getSlackError(result.error)}.`,
        },
        { status: 502 },
      );
    }

    return Response.json({ success: true });
  } catch {
    return Response.json(
      {
        success: false,
        error: "Slack connectivity test failed.",
      },
      { status: 502 },
    );
  }
}
