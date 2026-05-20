package main

import (
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func TestChannelRecordFromMeta(t *testing.T) {
	jid := types.JID{User: "123", Server: types.NewsletterServer}
	row := channelRecordFromMeta(&types.NewsletterMetadata{
		ID: jid,
		State: types.WrappedNewsletterState{
			Type: types.NewsletterStateActive,
		},
		ThreadMeta: types.NewsletterThreadMetadata{
			Name:            types.NewsletterText{Text: "  News  "},
			Description:     types.NewsletterText{Text: "Updates"},
			SubscriberCount: 42,
		},
		ViewerMeta: &types.NewsletterViewerMetadata{
			Role: types.NewsletterRoleAdmin,
			Mute: types.NewsletterMuteOff,
		},
	})

	if row.JID != jid.String() || row.Name != "News" || row.Role != "admin" || row.Mute != "off" || row.State != "active" || row.Subscribers != 42 {
		t.Fatalf("unexpected row: %+v", row)
	}
}

func TestParseChannelJIDRejectsNonChannel(t *testing.T) {
	if _, err := parseChannelJID("123@s.whatsapp.net"); err == nil {
		t.Fatal("expected non-channel JID to fail")
	}
	jid, err := parseChannelJID("123@newsletter")
	if err != nil {
		t.Fatalf("parseChannelJID: %v", err)
	}
	if jid.Server != types.NewsletterServer {
		t.Fatalf("server = %q", jid.Server)
	}
}

func TestChatKindFromJIDNewsletter(t *testing.T) {
	got := chatKindFromJID(types.JID{User: "123", Server: types.NewsletterServer})
	if got != "newsletter" {
		t.Fatalf("chatKindFromJID = %q", got)
	}
}
