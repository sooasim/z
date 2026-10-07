-- 0700 COMMS-02 notification templates (ko-KR, en-US) + delivery retry bookkeeping.
ALTER TABLE notification_deliveries
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN rendered jsonb;
CREATE INDEX idx_notification_deliveries_queue ON notification_deliveries(next_attempt_at) WHERE status = 'QUEUED';

INSERT INTO notification_templates(template_key, channel, locale, subject, body) VALUES
 ('generic','EMAIL','ko-KR','[JETPOOL] {{title}}','{{displayName}}님, {{body}}'),
 ('generic','EMAIL','en-US','[JETPOOL] {{title}}','Hi {{displayName}}, {{body}}'),
 ('generic','SMS','ko-KR',NULL,'[JETPOOL] {{title}}'),
 ('generic','SMS','en-US',NULL,'[JETPOOL] {{title}}'),
 ('generic','PUSH','ko-KR','{{title}}','{{body}}'),
 ('generic','PUSH','en-US','{{title}}','{{body}}'),
 ('generic','KAKAO_ALIMTALK','ko-KR',NULL,E'[JETPOOL] {{title}}\n{{body}}'),
 ('message.received','EMAIL','ko-KR','[JETPOOL] 새 메시지가 도착했습니다','{{displayName}}님, {{senderName}}님이 메시지를 보냈습니다. 앱에서 확인해 주세요.'),
 ('message.received','EMAIL','en-US','[JETPOOL] You have a new message','Hi {{displayName}}, {{senderName}} sent you a message. Open the app to reply.'),
 ('message.received','PUSH','ko-KR','새 메시지','{{senderName}}: 새 메시지가 도착했습니다'),
 ('message.received','PUSH','en-US','New message','{{senderName}} sent you a message'),
 ('reservation.confirmed','EMAIL','ko-KR','[JETPOOL] 예약이 확정되었습니다 ({{code}})','{{displayName}}님, 예약 {{code}}이(가) 확정되었습니다.'),
 ('reservation.confirmed','EMAIL','en-US','[JETPOOL] Your reservation is confirmed ({{code}})','Hi {{displayName}}, reservation {{code}} is confirmed.'),
 ('reservation.confirmed','KAKAO_ALIMTALK','ko-KR',NULL,E'[JETPOOL] 예약 확정 안내\n예약번호: {{code}}'),
 ('payment.approved','EMAIL','ko-KR','[JETPOOL] 결제가 완료되었습니다','{{displayName}}님, 결제가 승인되었습니다.'),
 ('payment.approved','EMAIL','en-US','[JETPOOL] Payment received','Hi {{displayName}}, your payment was approved.'),
 ('security.new_login','EMAIL','ko-KR','[JETPOOL] 새로운 로그인 알림','{{displayName}}님, 새 기기에서 로그인되었습니다. 본인이 아니라면 즉시 비밀번호를 변경해 주세요.'),
 ('security.new_login','EMAIL','en-US','[JETPOOL] New sign-in','Hi {{displayName}}, a new device signed in to your account. If this was not you, change your password now.'),
 ('integration.conflict','EMAIL','ko-KR','[JETPOOL] 외부 캘린더 충돌','{{displayName}}님, 외부 캘린더 일정({{start}}~{{end}})이 JETPOOL 예약과 겹칩니다. JETPOOL 예약이 우선 적용됩니다.'),
 ('integration.conflict','EMAIL','en-US','[JETPOOL] External calendar conflict','Hi {{displayName}}, an external calendar event ({{start}}–{{end}}) overlaps a JETPOOL booking. The JETPOOL booking takes precedence.'),
 ('marketing.promotion','EMAIL','ko-KR','(광고) {{title}}',E'{{body}}\n\n수신거부: 계정 > 알림 설정'),
 ('marketing.promotion','EMAIL','en-US','(Ad) {{title}}',E'{{body}}\n\nUnsubscribe: Account > Notifications');
