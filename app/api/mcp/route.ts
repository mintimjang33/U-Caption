import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { getSupabaseServerClient } from '../../../lib/supabase';

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

const baseHandler = createMcpHandler(
  (server) => {
    server.registerTool(
      'get_youtube_transcript',
      {
        title: '유튜브 자막 가져오기 요청',
        description:
          '유튜브 영상 링크의 자막(자동생성 포함)을 가져오는 작업을 큐에 등록한다. 사용자 PC에 U-Caption 크롬 확장프로그램이 설치/연결돼 있어야 하고, 로컬 워커가 최대 1분 주기로 큐를 확인하므로 즉시 완료되지 않는다 — job_id를 받아서 30초~1분 정도 뒤에 get_transcript_job_result로 결과를 다시 확인할 것.',
        inputSchema: { url: z.string().describe('유튜브 영상 URL (watch, youtu.be, shorts 형식 모두 지원)') },
      },
      async ({ url }) => {
        const videoId = extractVideoId(url);
        if (!videoId) {
          return { content: [{ type: 'text', text: `유효한 유튜브 링크를 찾지 못했어요: ${url}` }], isError: true };
        }
        const supabase = getSupabaseServerClient();
        const { data, error } = await supabase
          .from('uc_jobs')
          .insert({ video_id: videoId, url, status: 'queued' })
          .select()
          .single();
        if (error) return { content: [{ type: 'text', text: `에러: ${error.message}` }], isError: true };
        return {
          content: [
            {
              type: 'text',
              text: `작업이 등록됐어요(job_id: ${data.id}). 사용자 PC의 크롬이 켜져 있고 U-Caption 확장프로그램이 연결돼 있어야 처리됩니다. 30초~1분 정도 뒤에 get_transcript_job_result(job_id: "${data.id}")로 결과를 확인해주세요.`,
            },
          ],
        };
      }
    );

    server.registerTool(
      'get_transcript_job_result',
      {
        title: '유튜브 자막 작업 결과 확인',
        description: 'get_youtube_transcript로 등록한 작업의 현재 상태(대기중/완료/실패)와 결과를 한 번 조회한다(대기하지 않고 즉시 반환).',
        inputSchema: { job_id: z.string().describe('get_youtube_transcript가 반환한 job_id') },
      },
      async ({ job_id }) => {
        const supabase = getSupabaseServerClient();
        const { data, error } = await supabase.from('uc_jobs').select('*').eq('id', job_id).single();
        if (error || !data) return { content: [{ type: 'text', text: '해당 job_id를 찾을 수 없어요.' }], isError: true };
        if (data.status === 'done') {
          const header = data.title ? `제목: ${data.title}\n언어: ${data.lang || '알 수 없음'}\n\n` : '';
          return { content: [{ type: 'text', text: header + (data.transcript || '') }] };
        }
        if (data.status === 'error') {
          return { content: [{ type: 'text', text: data.error || '자막을 가져오지 못했어요.' }], isError: true };
        }
        return { content: [{ type: 'text', text: '아직 처리 중이에요(대기중). 잠시 후 다시 확인해주세요.' }] };
      }
    );
  }
);

async function authedHandler(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!process.env.UC_SHARED_SECRET || key !== process.env.UC_SHARED_SECRET) {
    return new Response(JSON.stringify({ error: '인증 필요 (key 파라미터 확인)' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return baseHandler(request);
}

export { authedHandler as GET, authedHandler as POST };
