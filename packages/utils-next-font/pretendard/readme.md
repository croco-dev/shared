# @croco/utils-next-font-pretendard

[Next.js Font Optimization](https://nextjs.org/docs/app/building-your-application/optimizing/fonts#local-fonts)을 사용하기 위한 Pretendard 폰트 패키지입니다.

## 라이선스 및 출처

- [Pretendard](https://github.com/orioncactus/pretendard) - [SIL Open Font License 1.1](https://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=OFL)
  - `PretendardVariable.woff2` 파일은 [GitHub 저장소](https://github.com/orioncactus/pretendard/tree/main/packages/pretendard/dist/web/variable/woff2)에서 가져왔습니다.

## 사용법

```tsx
// app/layout.tsx
import { pretendardFont } from '@croco/utils-next-font-pretendard';

export default function RootLayout() {
  return (
    <html lang="ko">
      ...
      <body className={pretendardFont.className}>
        ...
      </body>
    </html>
  );
}

```