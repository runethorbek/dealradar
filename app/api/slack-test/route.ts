import { postSlackMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

const testMessage = "DealRadar Slack integration is working.";

export async function POST() {
  const result = await postSlackMessage(testMessage);

  if (result.success) {
    return Response.json({ success: true });
  }

  const notConfigured = result.error === "not_configured";

  return Response.json(
    {
      success: false,
      error: notConfigured
        ? "Slack is not configured on the server."
        : `Slack rejected the message: ${result.error}.`,
    },
    { status: notConfigured ? 500 : 502 },
  );
}
