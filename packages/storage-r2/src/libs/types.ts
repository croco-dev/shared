/**
 * Cloudflare R2 제공자 생성에 필요한 설정입니다.
 */
export type R2Options = {
  /**
   * Cloudflare Account ID
   */
  accountId: string;

  /**
   * R2 Access Key ID
   */
  accessKeyId: string;

  /**
   * R2 Secret Access Key
   */
  secretAccessKey: string;

  /**
   * R2 버킷 이름
   */
  bucket: string;

  /**
   * 공개 URL 기본 경로 (선택)
   *
   * getPublicUrl 호출 시 R2에서 발급한 공개 도메인 또는 커스텀 도메인을 설정해야 합니다.
   * 예: 'https://cdn.example.com'
   *
   * 설정하지 않으면 getPublicUrl이 MissingR2ConfigProblem을 발생시킵니다.
   * 비공개 객체 작업과 서명 URL 생성에는 필요하지 않습니다.
   */
  publicUrlBase?: string;
};
