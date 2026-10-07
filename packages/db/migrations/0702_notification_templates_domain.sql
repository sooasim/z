-- 0702 COMMS-02 templates for domain notification keys emitted by booking/payments/exchange/guide/identity.
-- Unknown keys fall back to 'generic'. Variables come from notifications.data plus {{title}}, {{body}}, {{displayName}}.
INSERT INTO notification_templates(template_key, channel, locale, subject, body) VALUES
 ('reservation.confirmed.guest','EMAIL','ko-KR','[JETPOOL] 예약이 확정되었습니다 ({{code}})','{{displayName}}님, 예약 {{code}} ({{checkIn}} ~ {{checkOut}})이 확정되었습니다. 정확한 주소와 체크인 안내는 앱의 예약 상세에서 확인하세요.'),
 ('reservation.confirmed.guest','EMAIL','en-US','[JETPOOL] Reservation confirmed ({{code}})','Hi {{displayName}}, reservation {{code}} ({{checkIn}} – {{checkOut}}) is confirmed. See the exact address and check-in details in the app.'),
 ('reservation.confirmed.guest','KAKAO_ALIMTALK','ko-KR',NULL,E'[JETPOOL] 예약 확정\n예약번호: {{code}}\n일정: {{checkIn}} ~ {{checkOut}}'),
 ('reservation.confirmed.host','EMAIL','ko-KR','[JETPOOL] 새 예약 ({{code}})','{{displayName}}님, 새 예약 {{code}} ({{checkIn}} ~ {{checkOut}})이 확정되었습니다.'),
 ('reservation.confirmed.host','EMAIL','en-US','[JETPOOL] New reservation ({{code}})','Hi {{displayName}}, a new reservation {{code}} ({{checkIn}} – {{checkOut}}) is confirmed.'),
 ('reservation.cancelled','EMAIL','ko-KR','[JETPOOL] 예약이 취소되었습니다','{{displayName}}님, {{body}}'),
 ('reservation.cancelled','EMAIL','en-US','[JETPOOL] Reservation cancelled','Hi {{displayName}}, {{body}}'),
 ('payment.failed','EMAIL','ko-KR','[JETPOOL] 결제에 실패했습니다','{{displayName}}님, 결제가 완료되지 않았습니다. {{body}}'),
 ('payment.failed','EMAIL','en-US','[JETPOOL] Payment failed','Hi {{displayName}}, your payment did not go through. {{body}}'),
 ('payment.refunded','EMAIL','ko-KR','[JETPOOL] 환불이 처리되었습니다','{{displayName}}님, {{body}}'),
 ('payment.refunded','EMAIL','en-US','[JETPOOL] Refund processed','Hi {{displayName}}, {{body}}'),
 ('exchange.confirmed','EMAIL','ko-KR','[JETPOOL] 홈 익스체인지가 확정되었습니다','{{displayName}}님, {{body}}'),
 ('exchange.confirmed','EMAIL','en-US','[JETPOOL] Home exchange confirmed','Hi {{displayName}}, {{body}}'),
 ('guide.booking.confirmed','EMAIL','ko-KR','[JETPOOL] 가이드 일정이 확정되었습니다','{{displayName}}님, {{body}}'),
 ('guide.booking.confirmed','EMAIL','en-US','[JETPOOL] Guide booking confirmed','Hi {{displayName}}, {{body}}'),
 ('auth.password_changed','EMAIL','ko-KR','[JETPOOL] 비밀번호가 변경되었습니다','{{displayName}}님, 계정 비밀번호가 변경되었습니다. 본인이 아니라면 즉시 고객센터에 알려주세요.'),
 ('auth.password_changed','EMAIL','en-US','[JETPOOL] Your password was changed','Hi {{displayName}}, your password was changed. If this was not you, contact support immediately.')
ON CONFLICT DO NOTHING;
