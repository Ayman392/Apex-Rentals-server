import nodemailer from "nodemailer";

let transporter;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

// Never throws: a failed email must not break a booking or the cron job.
export async function sendMail({ to, subject, html }) {
  const mailer = getTransporter();
  if (!mailer || !to) {
    console.warn("Email skipped: SMTP not configured or no recipient");
    return false;
  }

  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || `Apex Rentals <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error("Email failed:", err.message);
    return false;
  }
}
