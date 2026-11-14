//! Friendships. A request is a row that becomes a friendship once accepted.
//! Lists and pending requests are capped, so no account can grow them without
//! bound or flood another player.

use crate::account::account_row;
use crate::{Account, Error, Result, Store, now};
use rusqlite::{Connection, OptionalExtension, params};

pub const MAX_FRIENDS: i64 = 200;
/// Pending requests one account may have sent.
pub const MAX_OUTGOING_REQUESTS: i64 = 50;
/// Pending requests one account may have waiting.
pub const MAX_INCOMING_REQUESTS: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FriendState {
    Friend,
    /// The other player asked; waiting for you.
    Incoming,
    /// You asked; waiting for them.
    Outgoing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Friend {
    pub account: Account,
    pub state: FriendState,
}

fn friend_count(db: &Connection, id: i64) -> Result<i64> {
    Ok(db.query_row(
        "SELECT COUNT(*) FROM friendships WHERE accepted = 1 AND (from_id = ?1 OR to_id = ?1)",
        [id],
        |r| r.get(0),
    )?)
}

/// Both players must have room for one more friend.
fn check_room(db: &Connection, a: i64, b: i64) -> Result<()> {
    if friend_count(db, a)? >= MAX_FRIENDS {
        return Err(Error::Limit("Your friend list is full"));
    }
    if friend_count(db, b)? >= MAX_FRIENDS {
        return Err(Error::Limit("That player's friend list is full"));
    }
    Ok(())
}

impl Store {
    /// Ask the player with this name to be friends. If they already asked you,
    /// this accepts their request. Repeats are no-ops.
    pub fn request(&self, from: i64, to_name: &str) -> Result<()> {
        let to = self.find_account(to_name)?.ok_or(Error::Invalid("No player has that name"))?;
        if to.id == from {
            return Err(Error::Invalid("You cannot befriend yourself"));
        }
        let mut db = self.db();
        let tx = db.transaction()?;
        let existing: Option<(i64, bool)> = tx
            .query_row(
                "SELECT from_id, accepted FROM friendships \
                 WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)",
                params![from, to.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match existing {
            // already friends, or the same request again
            Some((_, true)) => {}
            Some((sender, false)) if sender == from => {}
            // they asked first, so asking back accepts their request
            Some((_, false)) => {
                check_room(&tx, from, to.id)?;
                tx.execute(
                    "UPDATE friendships SET accepted = 1 WHERE from_id = ?1 AND to_id = ?2",
                    params![to.id, from],
                )?;
            }
            None => {
                let outgoing: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM friendships WHERE from_id = ?1 AND accepted = 0",
                    [from],
                    |r| r.get(0),
                )?;
                if outgoing >= MAX_OUTGOING_REQUESTS {
                    return Err(Error::Limit("You have too many pending requests"));
                }
                let incoming: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM friendships WHERE to_id = ?1 AND accepted = 0",
                    [to.id],
                    |r| r.get(0),
                )?;
                if incoming >= MAX_INCOMING_REQUESTS {
                    return Err(Error::Limit("That player has too many pending requests"));
                }
                check_room(&tx, from, to.id)?;
                tx.execute(
                    "INSERT INTO friendships (from_id, to_id, accepted, created) VALUES (?1, ?2, 0, ?3)",
                    params![from, to.id, now()],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Accept a request the player `from_name` sent you.
    pub fn accept(&self, account: i64, from_name: &str) -> Result<()> {
        let other = self.find_account(from_name)?.ok_or(Error::Invalid("No player has that name"))?;
        let mut db = self.db();
        let tx = db.transaction()?;
        let pending = tx
            .query_row(
                "SELECT 1 FROM friendships WHERE from_id = ?1 AND to_id = ?2 AND accepted = 0",
                params![other.id, account],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !pending {
            return Err(Error::Invalid("That player has not asked to be your friend"));
        }
        check_room(&tx, account, other.id)?;
        tx.execute(
            "UPDATE friendships SET accepted = 1 WHERE from_id = ?1 AND to_id = ?2",
            params![other.id, account],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// End a friendship, cancel a request you sent, or decline one you got.
    pub fn remove(&self, account: i64, other_name: &str) -> Result<()> {
        let other = self.find_account(other_name)?.ok_or(Error::Invalid("No player has that name"))?;
        self.db().execute(
            "DELETE FROM friendships WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)",
            params![account, other.id],
        )?;
        Ok(())
    }

    /// Friends and requests in either direction, sorted by name.
    pub fn friends(&self, account: i64) -> Result<Vec<Friend>> {
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT a.id, a.name, f.from_id = ?1, f.accepted FROM friendships f \
             JOIN accounts a ON a.id = (CASE WHEN f.from_id = ?1 THEN f.to_id ELSE f.from_id END) \
             WHERE f.from_id = ?1 OR f.to_id = ?1 ORDER BY a.name_key",
        )?;
        let rows = stmt.query_map([account], |r| {
            let from_me: bool = r.get(2)?;
            let accepted: bool = r.get(3)?;
            let state = if accepted {
                FriendState::Friend
            } else if from_me {
                FriendState::Outgoing
            } else {
                FriendState::Incoming
            };
            Ok(Friend { account: account_row(r)?, state })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<Friend>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{raw_account, store};

    fn raw_friendship(s: &Store, from: i64, to: i64, accepted: bool) {
        s.db()
            .execute(
                "INSERT INTO friendships (from_id, to_id, accepted, created) VALUES (?1, ?2, ?3, 0)",
                params![from, to, accepted],
            )
            .unwrap();
    }

    fn state_of(s: &Store, me: i64, other: &str) -> Option<FriendState> {
        s.friends(me).unwrap().into_iter().find(|f| f.account.name == other).map(|f| f.state)
    }

    #[test]
    fn a_request_shows_on_both_sides() {
        let s = store();
        let al = raw_account(&s, "Al");
        let bea = raw_account(&s, "Bea");
        s.request(al, "Bea").unwrap();
        assert_eq!(state_of(&s, al, "Bea"), Some(FriendState::Outgoing));
        assert_eq!(state_of(&s, bea, "Al"), Some(FriendState::Incoming));
    }

    #[test]
    fn bad_targets_are_refused() {
        let s = store();
        let al = raw_account(&s, "Al");
        assert!(matches!(s.request(al, "Nobody"), Err(Error::Invalid(_))));
        assert!(matches!(s.request(al, "al"), Err(Error::Invalid(_))), "yourself, ignoring case");
    }

    #[test]
    fn repeated_requests_are_no_ops() {
        let s = store();
        let al = raw_account(&s, "Al");
        let bea = raw_account(&s, "Bea");
        s.request(al, "Bea").unwrap();
        s.request(al, "Bea").unwrap();
        assert_eq!(s.friends(al).unwrap().len(), 1);
        assert_eq!(s.friends(bea).unwrap().len(), 1);
    }

    #[test]
    fn asking_back_makes_a_friendship() {
        let s = store();
        let al = raw_account(&s, "Al");
        let bea = raw_account(&s, "Bea");
        s.request(bea, "Al").unwrap();
        s.request(al, "Bea").unwrap();
        assert_eq!(state_of(&s, al, "Bea"), Some(FriendState::Friend));
        assert_eq!(state_of(&s, bea, "Al"), Some(FriendState::Friend));
        s.request(al, "Bea").unwrap(); // already friends
        s.request(bea, "Al").unwrap();
        assert_eq!(state_of(&s, bea, "Al"), Some(FriendState::Friend));
    }

    #[test]
    fn accepting_needs_a_request_from_that_player() {
        let s = store();
        let al = raw_account(&s, "Al");
        let bea = raw_account(&s, "Bea");
        assert!(matches!(s.accept(al, "Bea"), Err(Error::Invalid(_))));
        s.request(bea, "Al").unwrap();
        assert!(matches!(s.accept(bea, "Al"), Err(Error::Invalid(_))), "the sender cannot accept their own request");
        s.accept(al, "Bea").unwrap();
        assert_eq!(state_of(&s, al, "Bea"), Some(FriendState::Friend));
    }

    #[test]
    fn remove_cancels_declines_or_unfriends() {
        let s = store();
        let al = raw_account(&s, "Al");
        let bea = raw_account(&s, "Bea");
        s.request(al, "Bea").unwrap();
        s.remove(al, "Bea").unwrap(); // cancel
        assert!(s.friends(al).unwrap().is_empty());
        s.request(al, "Bea").unwrap();
        s.remove(bea, "Al").unwrap(); // decline
        assert!(s.friends(bea).unwrap().is_empty());
        s.request(bea, "Al").unwrap();
        s.accept(al, "Bea").unwrap();
        s.remove(bea, "Al").unwrap(); // unfriend
        assert!(s.friends(al).unwrap().is_empty());
        assert!(matches!(s.remove(al, "Nobody"), Err(Error::Invalid(_))));
    }

    #[test]
    fn outgoing_requests_are_capped() {
        let s = store();
        let al = raw_account(&s, "Al");
        for i in 0..=MAX_OUTGOING_REQUESTS {
            raw_account(&s, &format!("Target{i}"));
            let r = s.request(al, &format!("Target{i}"));
            if i < MAX_OUTGOING_REQUESTS {
                r.unwrap();
            } else {
                assert_eq!(r, Err(Error::Limit("You have too many pending requests")));
            }
        }
    }

    #[test]
    fn incoming_requests_are_capped() {
        let s = store();
        let hub = raw_account(&s, "Hub");
        for i in 0..=MAX_INCOMING_REQUESTS {
            let from = raw_account(&s, &format!("Sender{i}"));
            let r = s.request(from, "Hub");
            if i < MAX_INCOMING_REQUESTS {
                r.unwrap();
            } else {
                assert_eq!(r, Err(Error::Limit("That player has too many pending requests")));
            }
        }
        assert_eq!(s.friends(hub).unwrap().len() as i64, MAX_INCOMING_REQUESTS);
    }

    #[test]
    fn friend_lists_are_capped() {
        let s = store();
        let al = raw_account(&s, "Al");
        for i in 0..MAX_FRIENDS {
            let f = raw_account(&s, &format!("Friend{i}"));
            raw_friendship(&s, al, f, true);
        }
        raw_account(&s, "Newcomer");
        assert_eq!(s.request(s.find_account("Newcomer").unwrap().unwrap().id, "Al"), Err(Error::Limit("That player's friend list is full")));
        assert_eq!(s.request(al, "Newcomer"), Err(Error::Limit("Your friend list is full")));
    }

    #[test]
    fn accepting_respects_the_friend_cap() {
        let s = store();
        let al = raw_account(&s, "Al");
        for i in 0..MAX_FRIENDS {
            let f = raw_account(&s, &format!("Friend{i}"));
            raw_friendship(&s, al, f, true);
        }
        let carol = raw_account(&s, "Carol");
        raw_friendship(&s, carol, al, false);
        assert_eq!(s.accept(al, "Carol"), Err(Error::Limit("Your friend list is full")));
        assert_eq!(s.request(al, "Carol"), Err(Error::Limit("Your friend list is full")));
        assert_eq!(state_of(&s, al, "Carol"), Some(FriendState::Incoming));
    }
}
