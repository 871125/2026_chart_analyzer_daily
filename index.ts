import axios from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';

// ==========================================
// 1. 설정 및 환경변수 로드
// ==========================================
import * as dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.BINGX_API_KEY || '';
const API_SECRET = process.env.BINGX_API_SECRET || '';
const BASE_URL = 'https://open-api.bingx.com';

// 봇 주요 설정
const SYMBOL = process.env.SYMBOL || 'BTC-USDT';
const LEVERAGE = parseInt(process.env.LEVERAGE || '10', 10);
const TRADE_AMOUNT_USDT = parseFloat(process.env.TRADE_AMOUNT_USDT || '100');
const ECONOMIC_API_KEY = process.env.ECONOMIC_API_KEY || ''; 

// 텔레그램 설정 (선택사항)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// 종목별 정밀도 (BTC 기준 기본값)
const QTY_PRECISION = 4;   // 수량 소수점 자리
const PRICE_PRECISION = 1; // 가격 소수점 자리

// 타임아웃 설정: 이 분(minutes)이 지나도 지정가가 안 긁히면 자동 취소
const ORDER_TIMEOUT_MINUTES = 45; 

// 타임존 및 파일 경로 (process.cwd()를 사용하여 모듈 충돌 원천 차단)
const TZ_EST = 'America/New_York';
const STATE_FILE = path.join(process.cwd(), `state_${SYMBOL}.json`);
const LOG_FILE = path.join(process.cwd(), `logs_${SYMBOL}.json`);

let isProcessing = false;

// ==========================================
// 2. 타입 및 인터페이스
// ==========================================
interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface AppState {
    date: string; 
    setupHigh: number | null;
    setupLow: number | null;
    tradedToday: boolean;
    isEventDay: boolean;
    pendingOrderId: string | null;      
    pendingOrderTime: number | null;    
    pendingOrderSide: string | null;    
    pendingOrderEp: number | null;      
}

interface TradeLog {
    timestamp: string;
    symbol: string;
    side: string;
    entryPrice: number;
    status: 'FILLED' | 'CANCELED_BY_TIMEOUT' | 'MANUAL_CANCELED';
    reason: string;
}

// ==========================================
// 3. 유틸리티 및 텔레그램 알림
// ==========================================
async function sendTelegramMsg(message: string): Promise<void> {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }, { timeout: 5000 });
    } catch (error) { 
        console.error('[-] 텔레그램 발송 실패 (봇은 정상 동작함)');
    }
}

async function loadState(): Promise<AppState> {
    try {
        const data = await fs.readFile(STATE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return { date: '', setupHigh: null, setupLow: null, tradedToday: false, isEventDay: false, pendingOrderId: null, pendingOrderTime: null, pendingOrderSide: null, pendingOrderEp: null };
    }
}

async function saveState(state: AppState): Promise<void> {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function logTrade(log: TradeLog): Promise<void> {
    let logs: TradeLog[] = [];
    try { logs = JSON.parse(await fs.readFile(LOG_FILE, 'utf-8')); } catch (e) { }
    logs.push(log);
    await fs.writeFile(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
}

function floorTo(num: number, precision: number): number {
    const m = Math.pow(10, precision); return Math.floor(num * m) / m;
}

function roundTo(num: number, precision: number): number {
    return Number(num.toFixed(precision));
}

// ==========================================
// 4. 거시경제 필터
// ==========================================
async function checkEconomicEvent(dateStr: string): Promise<boolean> {
    if (!ECONOMIC_API_KEY) return false;
    try {
        const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${dateStr}&to=${dateStr}&apikey=${ECONOMIC_API_KEY}`;
        // 재시도 로직이 포함된 안전한 호출
        const response = await axios.get(url, { timeout: 10000 });
        const highImpactKeywords = ['CPI', 'FOMC', 'Non Farm', 'Interest Rate', 'Fed Chair Powell', 'GDP'];

        for (const event of response.data) {
            if (event.currency === 'USD') {
                const eventName = event.event.toUpperCase();
                if (highImpactKeywords.some(keyword => eventName.includes(keyword.toUpperCase()))) return true; 
            }
        }
        return false;
    } catch (error) {
        console.error('[!] 이벤트 캘린더 확인 실패. 보수적 접근으로 당일 매매 일시 중지.');
        return true; 
    }
}

// ==========================================
// 5. BingX API 코어 (재시도 로직 포함)
// ==========================================
function generateSignature(params: Record<string, any>): string {
    const queryStr = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
    return crypto.createHmac('sha256', API_SECRET).update(queryStr).digest('hex');
}

async function bingxRequest(method: 'GET' | 'POST' | 'DELETE', endpoint: string, params: Record<string, any> = {}, retries = 3): Promise<any> {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    params.signature = generateSignature(params);

    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios({
                method,
                url: `${BASE_URL}${endpoint}`,
                params: (method === 'GET' || method === 'DELETE') ? params : undefined,
                data: method === 'POST' ? params : undefined,
                headers: { 'X-BX-APIKEY': API_KEY, 'Content-Type': 'application/json' },
                timeout: 8000 // 8초 타임아웃 방어
            });
            return response.data;
        } catch (error: any) {
            if (i === retries - 1) throw new Error(error.response?.data?.msg || error.message);
            await new Promise(res => setTimeout(res, 1000)); // 1초 대기 후 재시도
        }
    }
}

async function getKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const res = await bingxRequest('GET', '/openApi/swap/v2/quote/klines', { symbol, interval, limit });
    if (res.code !== 0) throw new Error(res.msg);
    return res.data.map((c: any) => ({
        timestamp: c.time, open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume)
    })).sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);
}

async function placeLimitOrder(side: 'LONG' | 'SHORT', ep: number, sl: number, tp: number): Promise<string | null> {
    const positionSizeUSDT = TRADE_AMOUNT_USDT * LEVERAGE;
    const orderQuantity = floorTo(positionSizeUSDT / ep, QTY_PRECISION);

    const finalEp = roundTo(ep, PRICE_PRECISION);
    const finalSl = roundTo(sl, PRICE_PRECISION);
    const finalTp = roundTo(tp, PRICE_PRECISION);

    try {
        const res = await bingxRequest('POST', '/openApi/swap/v2/trade/order', {
            symbol: SYMBOL, side: side === 'LONG' ? 'BUY' : 'SELL', positionSide: side, type: 'LIMIT', price: finalEp, quantity: orderQuantity, 
            stopLoss: JSON.stringify({ type: 'STOP_MARKET', stopPrice: finalSl, workingType: 'MARK_PRICE' }),
            takeProfit: JSON.stringify({ type: 'TAKE_PROFIT_MARKET', stopPrice: finalTp, workingType: 'MARK_PRICE' })
        });
        if (res.code === 0 && res.data && res.data.orderId) return res.data.orderId.toString();
        throw new Error(res.msg);
    } catch (error: any) {
        console.error(`[-] 주문 생성 실패:`, error.message);
        return null;
    }
}

async function getOrderStatus(orderId: string): Promise<string | null> {
    try {
        const res = await bingxRequest('GET', '/openApi/swap/v2/trade/order', { symbol: SYMBOL, orderId });
        if (res.code === 0 && res.data && res.data.order) return res.data.order.status; 
        return null;
    } catch (error) { return null; }
}

async function cancelOrder(orderId: string): Promise<boolean> {
    try {
        const res = await bingxRequest('DELETE', '/openApi/swap/v2/trade/order', { symbol: SYMBOL, orderId });
        return res.code === 0;
    } catch (error) { return false; }
}

// ==========================================
// 6. 메인 전략 엔진 (1분마다 실행)
// ==========================================
async function runStrategy() {
    if (isProcessing) return; 
    isProcessing = true;

    try {
        const now = new Date();
        const estTime = toZonedTime(now, TZ_EST);
        const currentDate = formatInTimeZone(estTime, TZ_EST, 'yyyy-MM-dd');
        
        let state = await loadState();

        // 🟢 날짜 변경 (00:00 EST) - 상태 초기화 및 이벤트 검사
        if (state.date !== currentDate) {
            console.log(`\n==========================================`);
            console.log(`📅 새로운 거래일 시작: ${currentDate} (EST) - ${SYMBOL}`);
            console.log(`==========================================`);
            const isEvent = await checkEconomicEvent(currentDate);
            if (isEvent) await sendTelegramMsg(`⚠️ <b>이벤트 데이 감지 (${SYMBOL})</b>\n지표 발표에 따른 휩소 방지를 위해 매매를 관망합니다.`);
            
            state = { date: currentDate, setupHigh: null, setupLow: null, tradedToday: false, isEventDay: isEvent, pendingOrderId: null, pendingOrderTime: null, pendingOrderSide: null, pendingOrderEp: null };
            await saveState(state);
        }

        if (state.isEventDay) return;

        // 🟠 예약 주문 타임아웃 관리
        if (state.pendingOrderId) {
            const status = await getOrderStatus(state.pendingOrderId);
            
            // 1) 체결 성공
            if (status === 'FILLED' || status === 'PARTIALLY_FILLED') {
                console.log(`[+] 지정가 예약 체결 완료!`);
                await sendTelegramMsg(`✅ <b>[지정가 체결 완료]</b>\n${SYMBOL} ${state.pendingOrderSide} 진입 성공 (${state.pendingOrderEp})`);
                await logTrade({ timestamp: new Date().toISOString(), symbol: SYMBOL, side: state.pendingOrderSide!, entryPrice: state.pendingOrderEp!, status: 'FILLED', reason: 'Retest Entry' });
                
                state.tradedToday = true; 
                state.pendingOrderId = null; state.pendingOrderTime = null; state.pendingOrderSide = null; state.pendingOrderEp = null;
                await saveState(state);
                return;
            } 
            // 2) 유저 수동 취소 등
            else if (status === 'CANCELED' || status === 'REJECTED') {
                state.tradedToday = true; 
                state.pendingOrderId = null; state.pendingOrderTime = null; state.pendingOrderSide = null; state.pendingOrderEp = null;
                await saveState(state);
                return;
            }
            // 3) 대기 중 -> 타임아웃 검사
            else if (status === 'NEW') {
                const elapsedMins = (Date.now() - (state.pendingOrderTime || Date.now())) / (1000 * 60);
                if (elapsedMins >= ORDER_TIMEOUT_MINUTES) {
                    const canceled = await cancelOrder(state.pendingOrderId);
                    if (canceled) {
                        console.log(`[-] 타임아웃 초과: 미체결 주문 자동 취소 진행`);
                        await sendTelegramMsg(`⏳ <b>[타임아웃 취소]</b>\n${SYMBOL} 되돌림 미발생으로 안전 취소 진행. (매매 종료)`);
                        await logTrade({ timestamp: new Date().toISOString(), symbol: SYMBOL, side: state.pendingOrderSide!, entryPrice: state.pendingOrderEp!, status: 'CANCELED_BY_TIMEOUT', reason: 'Timeout' });
                        
                        state.tradedToday = true; 
                        state.pendingOrderId = null; state.pendingOrderTime = null; state.pendingOrderSide = null; state.pendingOrderEp = null;
                        await saveState(state);
                    }
                }
                return; // 대기 중에는 신규 시그널 탐색 안함
            }
        }

        if (state.tradedToday) return;

        // 🔵 5분봉 기준선 캡처 (09:35 EST)
        const timeAsNumber = estTime.getHours() * 100 + estTime.getMinutes();
        if (timeAsNumber >= 935 && (state.setupHigh === null || state.setupLow === null)) {
            const klines5m = await getKlines(SYMBOL, '5m', 5);
            const setupCandle = klines5m.find(c => {
                const cTime = toZonedTime(new Date(c.timestamp), TZ_EST);
                return cTime.getHours() === 9 && cTime.getMinutes() === 30;
            });
            if (setupCandle) {
                state.setupHigh = setupCandle.high; state.setupLow = setupCandle.low;
                await saveState(state);
                console.log(`[i] 기준선 확보 -> High: ${state.setupHigh}, Low: ${state.setupLow}`);
            }
        }

        // 🟣 FVG 돌파 감시 및 지정가 예약 (09:35 ~ 11:00 EST)
        if (state.setupHigh && state.setupLow && timeAsNumber >= 935 && timeAsNumber <= 1100 && !state.pendingOrderId) {
            const klines1m = await getKlines(SYMBOL, '1m', 10);
            if (klines1m.length < 5) return;

            const c1 = klines1m[klines1m.length - 4];
            const c3 = klines1m[klines1m.length - 2];

            // LONG 시그널 (돌파 + Bullish FVG)
            if (c3.close > state.setupHigh && c1.high < c3.low) {
                const ep = state.setupHigh;
                const sl = Math.min(...klines1m.slice(-6, -1).map(c => c.low));
                let risk = ep - sl; 
                if (risk < ep * 0.001) risk = ep * 0.001; // 최소 손절폭 보정 (핵심)
                const tp = ep + (risk * 2);

                const orderId = await placeLimitOrder('LONG', ep, sl, tp);
                if (orderId) { 
                    state.pendingOrderId = orderId; state.pendingOrderTime = Date.now(); state.pendingOrderSide = 'LONG'; state.pendingOrderEp = ep;
                    await saveState(state);
                    await sendTelegramMsg(`🟢 <b>[LONG 지정가 예약]</b>\n\n• 종목: ${SYMBOL}\n• 진입대기: ${roundTo(ep, PRICE_PRECISION)}\n• 목표(TP): ${roundTo(tp, PRICE_PRECISION)}\n• 손절(SL): ${roundTo(sl, PRICE_PRECISION)}`);
                }
                return;
            }

            // SHORT 시그널 (돌파 + Bearish FVG)
            if (c3.close < state.setupLow && c1.low > c3.high) {
                const ep = state.setupLow;
                const sl = Math.max(...klines1m.slice(-6, -1).map(c => c.high));
                let risk = sl - ep; 
                if (risk < ep * 0.001) risk = ep * 0.001; // 최소 손절폭 보정
                const tp = ep - (risk * 2);

                const orderId = await placeLimitOrder('SHORT', ep, sl, tp);
                if (orderId) { 
                    state.pendingOrderId = orderId; state.pendingOrderTime = Date.now(); state.pendingOrderSide = 'SHORT'; state.pendingOrderEp = ep;
                    await saveState(state);
                    await sendTelegramMsg(`🔴 <b>[SHORT 지정가 예약]</b>\n\n• 종목: ${SYMBOL}\n• 진입대기: ${roundTo(ep, PRICE_PRECISION)}\n• 목표(TP): ${roundTo(tp, PRICE_PRECISION)}\n• 손절(SL): ${roundTo(sl, PRICE_PRECISION)}`);
                }
                return;
            }
        }
    } catch (e: any) {
        // 일시적인 네트워크 오류 등은 콘솔에만 찍고 봇을 죽이지 않음
        if (e.message.includes('timeout') || e.message.includes('Network')) {
            console.log(`[!] 네트워크 지연 발생. 다음 틱에 재시도합니다.`);
        } else {
            console.error('[!] 전략 루프 에러:', e.message);
        }
    } finally {
        isProcessing = false; 
    }
}

// ==========================================
// 7. 시스템 부트
// ==========================================
async function startBot() {
    console.log(`\n🚀 [ Casper Sniper Bot - Production V5 ] 구동을 시작합니다.`);
    console.log(`- 타겟 심볼: ${SYMBOL}`);
    console.log(`- 지정가 타임아웃: ${ORDER_TIMEOUT_MINUTES}분`);
    
    await sendTelegramMsg(`🚀 <b>Casper Bot (${SYMBOL}) 구동 시작</b>\n서버 및 매매 모니터링이 정상적으로 실행되었습니다.`);
    
    await runStrategy();
    setInterval(runStrategy, 60 * 1000); 
}

startBot();