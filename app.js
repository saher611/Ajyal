const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const FormData = require('form-data');
const { google } = require('googleapis');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

const env = (key, fallback = undefined) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing env: ${key}`);
  return value;
};

const optionalEnv = (key, fallback = undefined) => process.env[key] || fallback;

const CONFIG = {
  port: Number(optionalEnv('PORT', 10000)),
  stateFile: path.resolve(process.cwd(), optionalEnv('STATE_FILE', 'bot_state.json')),
  telegram: {
    token: env('TELEGRAM_TOKEN'),
    chatId: env('TELEGRAM_CHAT_ID'),
    webhookDomain: optionalEnv('TELEGRAM_WEBHOOK_DOMAIN'),
    webhookPath: optionalEnv('TELEGRAM_WEBHOOK_PATH', '/telegram'),
  },
  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('PHONE_NUMBER_ID'),
    verifyToken: env('VERIFY_TOKEN'),
    templateName: optionalEnv('WHATSAPP_TEMPLATE_NAME'),
    templateLang: optionalEnv('WHATSAPP_TEMPLATE_LANG', 'ar'),
    apiVersion: optionalEnv('WHATSAPP_API_VERSION', 'v20.0'),
  },
  sheets: {
    id: env('SHEET_ID'),
    range: optionalEnv('SHEET_RANGE', 'Sheet1!A:C'),
    email: env('GOOGLE_EMAIL'),
    key: env('GOOGLE_KEY').replace(/\\n/g, '\n'),
  },
};

const logger = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
};

const bot = new Telegraf(CONFIG.telegram.token);

const googleAuth = new google.auth.JWT(
  CONFIG.sheets.email,
  null,
  CONFIG.sheets.key,
  ['https://www.googleapis.com/auth/spreadsheets'],
);
const sheets = google.sheets({ version: 'v4', auth: googleAuth });

const wa = axios.create({
  baseURL: `https://graph.facebook.com/${CONFIG.whatsapp.apiVersion}/${CONFIG.whatsapp.phoneNumberId}`,
  timeout: 30000,
  headers: { Authorization: `Bearer ${CONFIG.whatsapp.token}` },
});

const state = {
  topicByPhone: new Map(),
  phoneByTopic: new Map(),
  nameByPhone: new Map(),
  pendingTopicByPhone: new Map(),
  sentByWaId: new Map(),
  outgoingByWaId: new Map(),
  processedInboundIds: new Map(),
};

const normalizePhone = (phone) => {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return '';
  return raw.startsWith('+') ? `+${digits}` : digits;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const compactError = (data) => {
  const err = data?.error || data || {};
  return [
    err.code && `code=${err.code}`,
    err.message,
    err.error_data?.details,
  ].filter(Boolean).join(' | ') || 'Unknown error';
};

const rememberTopic = (phone, topicId, name) => {
  const normalized = normalizePhone(phone);
  if (normalized && topicId) {
    const id = String(topicId);
    state.topicByPhone.set(normalized, id);
    state.phoneByTopic.set(id, normalized);
