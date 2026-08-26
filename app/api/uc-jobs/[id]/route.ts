import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '../../../../lib/supabase';

function checkKey(request: Request) {
  const key = new URL(request.url).searchParams.get('key');
  return !!process.env.UC_SHARED_SECRET && key === process.env.UC_SHARED_SECRET;
}

// PATCH /api/uc-jobs/[id]?key=... — 로컬 크롬 확장이 처리 결과를 보고할 때 사용.
// body: { status: 'done'|'error', title?, transcript?, lang?, error? }
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!checkKey(request)) return NextResponse.json({ error: '인증 필요' }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body?.status) return NextResponse.json({ error: 'status가 필요합니다.' }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from('uc_jobs')
    .update({
      status: body.status,
      title: body.title ?? null,
      transcript: body.transcript ?? null,
      lang: body.lang ?? null,
      error: body.error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ job: data });
}
