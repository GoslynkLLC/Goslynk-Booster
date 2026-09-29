import nodemailer from "nodemailer";

function boolEnv(name, fallback = false) {
  const value = process.env[name];

  if (value == null || value === "") {
    return fallback;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function getTransporter() {
  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT || 465);
  const secure = boolEnv("MAIL_SECURE", true);
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      "Thiếu cấu hình MAIL_HOST, MAIL_USER hoặc MAIL_PASS.",
    );
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });
}

export async function verifyMailer() {
  const transporter = getTransporter();
  await transporter.verify();
}

export async function sendPasswordResetCode({
    to,
    code,
    expiresInMinutes = 15,
  }) {
    const transporter = getTransporter();

    const from =
      process.env.MAIL_FROM ||
      process.env.MAIL_USER;

    const subject = "Mã xác nhận đặt lại mật khẩu | Goslynk Booster";

    const text = [
      "Goslynk Booster",
      "",
      "Xin chào,",
      "",
      "Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.",
      "",
      `Mã xác nhận của bạn là: ${code}`,
      "",
      `Mã có hiệu lực trong ${expiresInMinutes} phút.`,
      "",
      "Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.",
      "",
      "Email này được gửi tự động từ hệ thống Goslynk Booster.",
    ].join("\n");

    const html = `
  <!doctype html>
  <html lang="vi">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Mã xác nhận đặt lại mật khẩu</title>
    </head>
    <body style="margin:0; padding:0; background-color:#f4f7fb; font-family:Arial, Helvetica, sans-serif; color:#1f2937;">
      <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
        Mã đặt lại mật khẩu Goslynk Booster của bạn là ${code}. Mã có hiệu lực trong ${expiresInMinutes} phút.
      </div>

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f7fb; margin:0; padding:24px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px; margin:0 auto;">
              <tr>
                <td style="padding:0 16px;">

                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 6px 24px rgba(15,23,42,0.08);">
                    <tr>
                      <td style="padding:32px 32px 16px 32px; text-align:center; background:linear-gradient(135deg,#111827 0%,#1f2937 100%);">
                        <div style="font-size:28px; font-weight:700; color:#ffffff; line-height:1.3;">
                          Goslynk Booster
                        </div>
                        <div style="margin-top:8px; font-size:14px; color:#d1d5db;">
                          Xác nhận đặt lại mật khẩu
                        </div>
                      </td>
                    </tr>

                    <tr>
                      <td style="padding:32px;">
                        <p style="margin:0 0 12px 0; font-size:16px; line-height:1.7; color:#111827;">
                          Xin chào,
                        </p>

                        <p style="margin:0 0 20px 0; font-size:16px; line-height:1.7; color:#374151;">
                          Chúng tôi đã nhận được yêu cầu đặt lại mật khẩu cho tài khoản Goslynk Booster của bạn.
                          Vui lòng sử dụng mã xác nhận bên dưới để tiếp tục:
                        </p>

                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                          <tr>
                            <td align="center">
                              <div style="
                                display:inline-block;
                                background:#f9fafb;
                                border:1px solid #e5e7eb;
                                border-radius:14px;
                                padding:18px 28px;
                                font-size:36px;
                                font-weight:700;
                                letter-spacing:10px;
                                color:#111827;
                              ">
                                ${code.split("").join(" ")}
                              </div>
                            </td>
                          </tr>
                        </table>

                        <p style="margin:0 0 16px 0; font-size:15px; line-height:1.7; color:#374151;">
                          Mã này có hiệu lực trong
                          <strong style="color:#111827;">${expiresInMinutes} phút</strong>.
                        </p>

                        <p style="margin:0 0 20px 0; font-size:15px; line-height:1.7; color:#374151;">
                          Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email này.
                          Vì lý do bảo mật, vui lòng không chia sẻ mã xác nhận cho bất kỳ ai.
                        </p>

                        <div style="margin-top:24px; padding:16px 18px; background:#f9fafb; border-left:4px solid #10b981; border-radius:10px;">
                          <p style="margin:0; font-size:14px; line-height:1.7; color:#4b5563;">
                            <strong>Lưu ý:</strong> Đội ngũ Goslynk Booster sẽ không bao giờ yêu cầu bạn cung cấp mã xác nhận qua chat, email hoặc điện thoại.
                          </p>
                        </div>
                      </td>
                    </tr>

                    <tr>
                      <td style="padding:20px 32px; background:#f9fafb; border-top:1px solid #e5e7eb; text-align:center;">
                        <p style="margin:0 0 8px 0; font-size:13px; color:#6b7280;">
                          Email này được gửi tự động từ hệ thống Goslynk Booster.
                        </p>
                        <p style="margin:0; font-size:13px; color:#9ca3af;">
                          Vui lòng không trả lời email này.
                        </p>
                      </td>
                    </tr>
                  </table>

                  <p style="margin:16px 0 0 0; text-align:center; font-size:12px; color:#9ca3af;">
                    © Goslynk Booster. All rights reserved.
                  </p>

                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
    `;

    return transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
    });
}