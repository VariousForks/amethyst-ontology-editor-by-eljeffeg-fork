// Lightweight optional SMTP wrapper.  If SMTP_HOST is not set, sendInviteEmail
// returns { sent: false } and the caller should surface the signup link directly
// in the UI instead of emailing it.
let transporter = null;
let loadPromise = null;

async function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const mod = await import("nodemailer");
        const nodemailer = mod.default || mod;
        transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || "587", 10),
          secure: process.env.SMTP_SECURE === "true",
          auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" }
            : undefined,
        });
        return transporter;
      } catch (err) {
        console.warn("[mailer] nodemailer unavailable:", err.message);
        return null;
      }
    })();
  }
  return loadPromise;
}

export function isMailerConfigured() {
  return !!process.env.SMTP_HOST;
}

export async function sendInviteEmail({ to, inviteUrl, invitedBy, role }) {
  const t = await getTransporter();
  if (!t) return { sent: false, reason: "SMTP not configured" };
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@ontology-editor.local";
  const subject = `You have been invited to the Ontology Editor`;
  const text = `${invitedBy || "A teammate"} has invited you to collaborate on an ontology (role: ${role}).

Accept your invite here:
${inviteUrl}

This link will expire in 7 days.`;
  const html = `<p>${escapeHtml(invitedBy || "A teammate")} has invited you to collaborate on an ontology (role: <b>${escapeHtml(role)}</b>).</p>
<p><a href="${inviteUrl}">Accept your invite</a></p>
<p style="color:#888;font-size:12px">This link expires in 7 days.</p>`;

  try {
    const info = await t.sendMail({ from, to, subject, text, html });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    return { sent: false, reason: err.message || String(err) };
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
