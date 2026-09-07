/**
 * Cloudinary 제공자 설정입니다.
 */
export type CloudinaryConfig = {
  /**
   * Cloudinary 클라우드 이름
   */
  cloudName: string;

  /**
   * Cloudinary API Key
   */
  apiKey: string;

  /**
   * Cloudinary API Secret
   */
  apiSecret: string;

  /**
   * HTTPS 사용 여부 (기본값: true)
   */
  secure?: boolean;

  /**
   * Upload intents use this base URL.
   */
  uploadBaseUrl?: string;

  /**
   * Server-side Cloudinary API requests use this base URL.
   */
  apiBaseUrl?: string;

  /**
   * Upload Intent TTL (초 단위, 1-3600, 기본값: 3600)
   */
  ttl?: number;
};

/**
 * Cloudinary 업로드에 사용할 확장 옵션입니다.
 */
export type CloudinaryUploadOptions = {
  /**
   * 업로드할 폴더 경로
   */
  folder?: string;

  /**
   * 사용자 정의 public ID (key)
   */
  publicId?: string;

  /**
   * 리소스 타입. CloudinaryProvider는 키 확장자로 전체 객체 lifecycle의 타입을 결정합니다.
   */
  resourceType?: "image" | "video" | "raw";

  /**
   * 태그 목록
   */
  tags?: string[];

  /**
   * 컨텍스트 메타데이터 (key-value 쌍)
   */
  context?: Record<string, string>;

  /**
   * 업로드 시 적용할 변환 (eager transformations)
   */
  eager?: unknown[];
};

/**
 * Cloudinary 변환 파라미터 타입입니다.
 */
export type CloudinaryTransformOptions = {
  width?: number;
  height?: number;
  crop?: "scale" | "fit" | "fill" | "limit" | "pad" | "crop" | "thumb";
  quality?: number;
  format?: string;
  dpr?: number;
};
