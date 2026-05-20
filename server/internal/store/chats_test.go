package store

import (
	"testing"
	"time"
)

func TestUpsertChatNameAndLastMessageTS(t *testing.T) {
	db := openTestDB(t)

	t1 := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	t2 := time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)

	if err := db.UpsertChat("123@s.whatsapp.net", "dm", "Alice", t1); err != nil {
		t.Fatalf("UpsertChat: %v", err)
	}
	// Empty name should not clobber.
	if err := db.UpsertChat("123@s.whatsapp.net", "dm", "", t2); err != nil {
		t.Fatalf("UpsertChat empty name: %v", err)
	}
	c, err := db.GetChat("123@s.whatsapp.net")
	if err != nil {
		t.Fatalf("GetChat: %v", err)
	}
	if c.Name != "Alice" {
		t.Fatalf("expected name to stay Alice, got %q", c.Name)
	}
	if !c.LastMessageTS.Equal(t2) {
		t.Fatalf("expected LastMessageTS=%s, got %s", t2, c.LastMessageTS)
	}

	// Older timestamp should not override.
	if err := db.UpsertChat("123@s.whatsapp.net", "dm", "Alice2", t1); err != nil {
		t.Fatalf("UpsertChat older ts: %v", err)
	}
	c, err = db.GetChat("123@s.whatsapp.net")
	if err != nil {
		t.Fatalf("GetChat: %v", err)
	}
	if !c.LastMessageTS.Equal(t2) {
		t.Fatalf("expected LastMessageTS to remain %s, got %s", t2, c.LastMessageTS)
	}
}

func TestChatStateColumnsAndFilters(t *testing.T) {
	db := openTestDB(t)
	now := time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)

	for _, row := range []struct {
		jid  string
		name string
		ts   time.Time
	}{
		{"a@s.whatsapp.net", "Alice", now.Add(-2 * time.Hour)},
		{"b@g.us", "Team", now.Add(-1 * time.Hour)},
		{"c@s.whatsapp.net", "Carol", now},
	} {
		if err := db.UpsertChat(row.jid, "dm", row.name, row.ts); err != nil {
			t.Fatalf("UpsertChat %s: %v", row.jid, err)
		}
	}
	if err := db.SetChatArchived("a@s.whatsapp.net", true); err != nil {
		t.Fatalf("SetChatArchived: %v", err)
	}
	if err := db.SetChatPinned("c@s.whatsapp.net", true); err != nil {
		t.Fatalf("SetChatPinned: %v", err)
	}
	if err := db.SetChatMutedUntil("b@g.us", -1); err != nil {
		t.Fatalf("SetChatMutedUntil: %v", err)
	}
	if err := db.SetChatUnread("b@g.us", true); err != nil {
		t.Fatalf("SetChatUnread: %v", err)
	}

	yes := true
	no := false
	cases := []struct {
		name   string
		filter ChatListFilter
		want   string
	}{
		{"archived", ChatListFilter{Archived: &yes}, "a@s.whatsapp.net"},
		{"not archived", ChatListFilter{Archived: &no}, "c@s.whatsapp.net"},
		{"pinned", ChatListFilter{Pinned: &yes}, "c@s.whatsapp.net"},
		{"muted", ChatListFilter{Muted: &yes}, "b@g.us"},
		{"unread", ChatListFilter{Unread: &yes}, "b@g.us"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			chats, err := db.ListChatsFiltered(tc.filter)
			if err != nil {
				t.Fatalf("ListChatsFiltered: %v", err)
			}
			if len(chats) == 0 || chats[0].JID != tc.want {
				t.Fatalf("first chat = %+v, want %s", chats, tc.want)
			}
		})
	}

	chats, err := db.ListChats("", 10)
	if err != nil {
		t.Fatalf("ListChats: %v", err)
	}
	if len(chats) != 3 || chats[0].JID != "c@s.whatsapp.net" {
		t.Fatalf("expected pinned chat first, got %+v", chats)
	}
	if !chats[1].Muted() || !chats[1].Unread {
		t.Fatalf("expected muted/unread state on second chat, got %+v", chats[1])
	}
}

func TestChatStateSettersCreateMissingChat(t *testing.T) {
	db := openTestDB(t)

	if err := db.SetChatMutedUntil("missing@s.whatsapp.net", -1); err != nil {
		t.Fatalf("SetChatMutedUntil: %v", err)
	}
	c, err := db.GetChat("missing@s.whatsapp.net")
	if err != nil {
		t.Fatalf("GetChat: %v", err)
	}
	if c.Kind != "unknown" || !c.Muted() {
		t.Fatalf("created chat = %+v", c)
	}
}
