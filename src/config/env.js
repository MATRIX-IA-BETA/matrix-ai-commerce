const env = {
  PORT: process.env.PORT || 3000,

  MERCADOLIVRE_CLIENT_ID: process.env.MERCADOLIVRE_CLIENT_ID,
  MERCADOLIVRE_CLIENT_SECRET: process.env.MERCADOLIVRE_CLIENT_SECRET,
  MERCADOLIVRE_REDIRECT_URI: process.env.MERCADOLIVRE_REDIRECT_URI,

  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,

  WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_API_VERSION: process.env.WHATSAPP_API_VERSION || "v23.0",

  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-5.6",
  SAC_AUTO_SEND_SIMPLE:
    String(process.env.SAC_AUTO_SEND_SIMPLE || "false").toLowerCase() === "true",

  BLING_CLIENT_ID: process.env.BLING_CLIENT_ID,
  BLING_CLIENT_SECRET: process.env.BLING_CLIENT_SECRET,
  BLING_REDIRECT_URI: process.env.BLING_REDIRECT_URI,
  BLING_API_BASE:
    process.env.BLING_API_BASE || "https://api.bling.com.br/Api/v3",
  BLING_AUTH_BASE:
    process.env.BLING_AUTH_BASE || "https://www.bling.com.br/Api/v3/oauth"
};

module.exports = { env };
