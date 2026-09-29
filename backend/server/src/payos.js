import crypto from "node:crypto";
import { config } from "./config.js";

function ensureConfigured() {
  if (
    !config.payosClientId ||
    !config.payosApiKey ||
    !config.payosChecksumKey ||
    !config.payosReturnUrl ||
    !config.payosCancelUrl
  ) {
    throw new Error(
      "Thiếu cấu hình payOS trong .env",
    );
  }
}

function createSignature({
  orderCode,
  amount,
  description,
  returnUrl,
  cancelUrl,
}) {
  /*
   * payOS yêu cầu chuỗi ký theo thứ tự alphabet:
   *
   * amount
   * cancelUrl
   * description
   * orderCode
   * returnUrl
   */
  const data =
    `amount=${amount}` +
    `&cancelUrl=${cancelUrl}` +
    `&description=${description}` +
    `&orderCode=${orderCode}` +
    `&returnUrl=${returnUrl}`;

  return crypto
    .createHmac(
      "sha256",
      config.payosChecksumKey,
    )
    .update(data)
    .digest("hex");
}

export async function createPayOSPayment({
  orderCode,
  amount,
  description,
  expiredAt,
}) {
  ensureConfigured();

  const body = {
    orderCode: Number(orderCode),
    amount: Number(amount),
    description,
    returnUrl:
      config.payosReturnUrl,
    cancelUrl:
      config.payosCancelUrl,
    expiredAt: Number(expiredAt),
  };

  body.signature =
    createSignature(body);

  const response = await fetch(
    `${config.payosApiBase}/v2/payment-requests`,
    {
      method: "POST",

      headers: {
        "content-type":
          "application/json",

        "x-client-id":
          config.payosClientId,

        "x-api-key":
          config.payosApiKey,
      },

      body: JSON.stringify(body),

      signal:
        AbortSignal.timeout(15000),
    },
  );

  let result = null;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      `payOS trả response không hợp lệ (${response.status})`,
    );
  }

  if (
    !response.ok ||
    result?.code !== "00" ||
    !result?.data
  ) {
    const message =
      result?.desc ||
      `payOS HTTP ${response.status}`;

    throw new Error(message);
  }

  return result.data;
}