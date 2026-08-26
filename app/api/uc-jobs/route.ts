import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '../../../lib/supabase';

function checkKey(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  return !!process.env.UC_SHARED_SECRET && key === process.env.UC_SHARED_SECRET;
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (u.hostname.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];
    }
  } catch {
    // not a valid URL
  }
  return null;
}

// GET /api/uc-jobs?key=...&status=queued — 로컬 크롬 확장이 처리할 작업을 폴링할 때 사용.
export async function GET(request: Request) {
  if (!checkKey(request)) return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  const status = new URL(request.url).searchParams.get('status');

  const supabase = getSupabaseServerClient();
  let query = supabase.from('uc_jobs').select('*').order('created_at', { ascending: true });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data || [] });
}

// POST /api/uc-jobs?key=... — 새 작업을 등록. body: { url, transcript?, title?, lang? }
// transcript가 같이 오면(크롬 확장 팝업의 "MCP로 보내기" 버튼 — 이미 결과를 손에 쥔 상태) 곧바로
// status='done'으로 등록한다. transcript 없이 url만 오면(MCP get_youtube_transcript 툴) 'queued'로
// 등록해서 로컬 확장이 폴링해 처리하도록 큐에 올린다.
export async function POST(request: Request) {
  if (!checkKey(request)) return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const url = body?.url?.trim();
  if (!url) return NextResponse.json({ error: 'url이 필요합니다.' }, { status: 400 });

  const videoId = extractVideoId(url);
  if (!videoId) return NextResponse.json({ error: '유효한 유튜브 링크가 아닙니다.' }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const insert = body.transcript
    ? { video_id: videoId, url, status: 'done', title: body.title || null, transcript: body.transcript, lang: body.lang || null }
    : { video_id: videoId, url, status: 'queued' };
  const { data, error } = await supabase.from('uc_jobs').insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: data });
}
