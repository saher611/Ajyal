const { Telegraf } = require('telegraf');
const axios = require('axios');
const { google } = require('googleapis');

// إعدادات البوت
const bot = new Telegraf('7774187219:AAHOX_6uP97I6769p7RndOclN6u_eYt2L5c');
const SPREADSHEET_ID = '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk';

// مفاتيح جوجل من ملفك الـ JSON
const googleConfig = {
    email: "telegtram-whatsapp@enhanced-mote-381411.iam.gserviceaccount.com",
    key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1xD5TjFs+07+C\nhLmxxNg3EvlxDoko1g7/vfXmRQntKVqFfLKuYXKq4mf1jFmAZSE6/mn4Dxy65iJA\nqCYxW5blkaaPPY5daWZqOHnyffNn7RiM47GdRodk2zf78ZuqM8PBcpyWG18wIOkf\nxDDDHvOhxPCLMpbyBuHsF9wMixp0RlJX8+VndaGNRWje8Z7cgrTLEZgxKGswJkHN\nofq8pUB/bYUS0oVXfCrlk24HVP4JVu7et/ajM3adeN/9cN8VRmh8EINCUhwpNefj\n/vvN7Q9dmPa0bCC7xlzuknP8M68w9RMQCBjP5jL/vf2gcRsl42HHKCP3JM6MhUdL\nlP0oKgXfAgMBAAECggEADvuAD67wDnuxu3ZpQAfzsoZz3SfPkngigF4OGM70BIJ2\nHa6ro8gQhZln7EuHTRgI5y31WicUvSsfA6lYjJT6GS4qRoBSbcy0TmkdVCmhmJ1o\neqSCDW601lFjifbeV+cwaY+i7JSRAgyUarPnOQ4iEuGC2lZvLr/2e1l0H+yPX6oQ\nhAlrqgimBqDOtFEshPuingZpdHS71W6MrYtXcBPcMFUOBJUKRNczT5CPFGIVsEF8\nZtXz1IXHW1bKLL2RGxBINxtloTQ5mZ8Bk4uotuGR1nNoxaIyhoMdsWN+s25ogdP0\nfIONJ6omUIH19G3rIvwTs4cmCSEJlkmpU5Wf0lCYwQKBgQDs0kGAXp1UEg/xutaT\nGrJ/hMUyG+vNFMSbI4S347FeLIOV6v+DtPfL4xSsIVGaIN3AUl1McyZZH2dZjFI3\nPeu0+MYJf7ELbbiGUQmmXpB3LDhVDob6ssykRxYT0UPW5708287wJx+/ysSnYFe3\nqT9Vlx7zKsP/GKNOyioKdsBjbwKBgQDEfJncY1hAoCIpdpHcK5SEDXoDL8QjjIe/\nTYN7XRveVYI6hcurAwco8vUbU226zhGmtrQzN3Zr0oKe0pDHFrI3kefGaJhm/Tz4\nDt8kmQ0ikf5ht5KuxMBGa7fkoDi7vwHkZhNbf5Q3v7fqwG/ZKRUWWQkFkM4/Otxl\nofoX8b+MkQKBgQDp2sYryUJ63ks4XVO+d8KEAcvoq4GyRivPNse7/vALGtHlnOUs\nXevEPj0PrOcz1/iiDbNr5tmbcFNSLiqRumejkXWds6ZUrshkemmZDBCEXfpSo8HO\nlflWz4uRjjf7Y2OPUU+L/lZvwf9neM+l4U9VaaF6ZmSc5ut8xk21f4aDqQKBgA0u\wu/rZmdnlwMrJlwcPGmjsdT25nTwH8dw/upO8+i12fftNB30JQ3VRyafMVSAMOT7\ixmIlhRj2kmnnPkOh8R8sI06RUdbpDSMYuJEtoHkQ6nwtBGvt6rB3WOkcEoAZbMa\nOiBAbgRTg5ZndNmgDP8j2BwcfAn3/AOBm5LxsEVRAoGAGowsUiZPQnga+ix3Hs5h\n8vS2eAGX/wrT8xDwj056RgYTaDs468X8X4tZFA+EOKtKJzZWkGuGx9ol4jt3xpDG\nTaTM0a/vzTNb2V/vbGTB+wMg4vjMjgkW+f6S4ii+rymsp2jccnI8lVo+CK6qkYwp\ns+L1qxYMXR9pSU18A7MJn2g=\n-----END PRIVATE KEY-----\n",
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
};

const auth = new google.auth.JWT(googleConfig.email, null, googleConfig.key, googleConfig.scopes);
const sheets = google.sheets({ version: 'v4', auth });

// وظيفة لحفظ البيانات في الجدول
async function saveToSheet(topicId, phone) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:B',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[topicId.toString(), phone.toString()]] }
        });
    } catch (e) { console.error("خطأ في حفظ الجدول:", e); }
}

// وظيفة لجلب الهاتف من الجدول
async function getPhoneFromSheet(topicId) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:B',
        });
        const rows = res.data.values;
        if (rows) {
            const match = rows.reverse().find(row => row[0] == topicId.toString());
            return match ? match[1] : null;
        }
    } catch (e) { return null; }
}

// استقبال رسائل تليجرام (الرد على الجار)
bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    const text = ctx.message.text;

    if (topicId && text) {
        const phone = await getPhoneFromSheet(topicId);
        if (phone) {
            // هنا تضع كود إرسال الواتساب الخاص بك (Ultramsg أو غيره)
            console.log(`إرسال إلى ${phone}: ${text}`);
            // أضف كود axios لإرسال الرسالة لواتساب هنا
        }
    }
});

bot.launch().then(() => console.log("البوت يعمل بنظام الذاكرة الدائمة ✅"));
