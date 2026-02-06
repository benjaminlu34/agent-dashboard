ALTER TABLE turns
  ADD CONSTRAINT turns_user_message_id_fkey
  FOREIGN KEY (user_message_id)
  REFERENCES messages(id);
