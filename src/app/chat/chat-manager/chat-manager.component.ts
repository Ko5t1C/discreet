import {
  Component,
  ComponentFactoryResolver,
  ElementRef,
  EventEmitter,
  HostListener,
  Injectable,
  Input,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';

import {MatSnackBar, MatSnackBarRef, SimpleSnackBar} from '@angular/material/snack-bar';

import {IrcClient} from '../../irc-client/irc-client';
import {MessagesWindowComponent} from '../messages-window/messages-window.component';
import {ChatInfo} from '../chat-info';
import {ChatData} from '../chat-data';
import {MatDialog, MatMenu} from '@angular/material';
import {ChatUser} from '../chat-user';
import {YoutubeVideoComponent} from '../../socialmedia/youtube-video/youtube-video.component';
import {EmojiDialogComponent} from '../dialogs/emoji-dialog/emoji-dialog.component';
import {DeviceDetectorService} from 'ngx-device-detector';
import {LoginInfo} from '../../irc-client/login-info';
import {MediaPlaylistComponent} from '../dialogs/media-playlist/media-playlist.component';
import {ChatMessage, ChatMessageType} from '../chat-message';

@Injectable({
  providedIn: 'root',
})
@Component({
  selector: 'app-chat-manager',
  templateUrl: './chat-manager.component.html',
  styleUrls: ['./chat-manager.component.scss']
})
export class ChatManagerComponent implements OnInit {
  @ViewChild(MessagesWindowComponent, {static: true})
  private messageWindow: MessagesWindowComponent;
  @ViewChild('userMenu', {static: true})
  userMenu: MatMenu;
  @ViewChild(YoutubeVideoComponent, {static: true})
  videoPlayer: YoutubeVideoComponent;
  @ViewChild('messageInput', {static: true})
  messageInput: ElementRef;

  @Input() loginInfo: LoginInfo;

  private chatList: ChatData[] = [];
  boundChatList: ChatData[] = [];
  currentChatInfo: ChatInfo;
  currentUser: ChatUser;
  currentMenuChat: ChatData;

  userMessage = '';
  textInputCaretPosition = 0;
  currentEmojiTextInput;

  awayMessage = '';

  // state variables
  showRightPanel = true;
  showUserList = true;
  isLoggedIn = false;

  screenHeight = window.innerHeight;
  screenWidth = window.innerWidth;

  @Output() chatClosed = new EventEmitter<any>();
  @Output() chatOpen = new EventEmitter<any>();
  @Output() chatLoading = new EventEmitter<boolean>();

  @HostListener('window:resize', ['$event'])
  onResize(event?) {
    this.screenHeight = window.innerHeight;
    this.screenWidth = window.innerWidth;
    if (this.screenWidth < 640) {
      this.showRightPanel = false;
      this.videoPlayer.toggleRightMargin(false);
    } else {
      this.showRightPanel = true;
      this.videoPlayer.toggleRightMargin(true);
    }
  }

  constructor(
    private snackBar: MatSnackBar,
    private componentFactoryResolver: ComponentFactoryResolver,
    public ircClient: IrcClient,
    public dialog: MatDialog,
    public deviceService: DeviceDetectorService
  ) {
    this.ircClient.connectionStatus.subscribe((connected) => {
      // TODO:
    });
    this.ircClient.loggedIn.subscribe((loggedIn) => {
      this.isLoggedIn = loggedIn;
      if (loggedIn) {
        this.chatLoading.emit(false);
      }
    });
    this.ircClient.messageReceive.subscribe((msg: ChatMessage) => {
      const ni = msg.sender.indexOf('!'); // <-- TODO: not sure if this check is still needed
      if (ni > 0) {
        msg.sender = msg.sender.substring(0, ni);
      }
      // the message is for the local user
      if (this.ircClient.config.nick === msg.target) {
        msg.target = msg.sender;
      }
      // set type to MESSAGE (TODO: add support for NOTICE and MOTD TEXT '372')
      msg.type = ChatMessageType.MESSAGE;
      const chat = this.chat(msg.target);
      chat.receive(msg);
      // Show notification popup if message is not coming from the currently opened chat
      if (chat.info !== this.currentChatInfo && !chat.hasUsers()) {
        const snackBarRef: MatSnackBarRef<SimpleSnackBar> = this.snackBar.open(`${msg.sender}: ${msg.message}`, 'Mostra', {
          duration: 5000,
          verticalPosition: 'top'
        });
        snackBarRef.onAction().subscribe(() => {
          this.show(msg.sender);
        });
      }
    });
    this.ircClient.usersList.subscribe((msg) => {
      let eventDescription;
      let eventType;
      switch (msg.action) {
        case 'LIST':
          this.addChatUser(msg.target, ...msg.users.filter((u) => {
            return u !== '';
          }));
          break;
        case 'AWAY':
          // TODO: flag the sender user as marked away
          // TODO: this require a global users list to be implemented
          const channel = this.channel();
          if (channel) {
            const user = channel.getUser(msg.user);
            if (user) {
              user.away = msg.message;
            }
          }
          break;
        case 'NICK':
          this.renChatUser(msg.user, msg.nick);
          break;
        case 'JOIN':
          eventType = ChatMessageType.JOIN;
          eventDescription = 'è entrato.';
          this.addChatUser(msg.target, msg.user);
          break;
        case 'PART':
          eventType = ChatMessageType.PART;
          eventDescription = 'è uscito.';
          this.delChatUser(msg.target, msg.user);
          break;
        case 'KICK':
          eventType = ChatMessageType.KICK;
          eventDescription = 'è stato espulso.';
          this.delChatUser(msg.target, msg.user);
          break;
        case 'QUIT':
          eventType = ChatMessageType.QUIT;
          msg.target = this.currentChatInfo.name;
          eventDescription = 'si è disconnesso.';
          this.delChatUser(msg.target, msg.user);
          break;
      }
      if (eventDescription) {
        // add join message to the chat buffer
        const chat = this.channel();
        if (chat) {
          const eventMessage = new ChatMessage();
          eventMessage.type = eventType;
          eventMessage.message = eventDescription;
          eventMessage.data = { description: msg.message };
          eventMessage.sender = msg.user;
          eventMessage.target = msg.target;
          chat.receive(eventMessage);
        }
      }
    });
    this.ircClient.joinChannel.subscribe(this.show.bind(this));
    this.ircClient.userMode.subscribe((m) => {
      // TODO: .... (for better perfs, this should be implemented
      //    via keeping a global list of users instead of instances
      //    for each channel)
      console.log('SERVER MODE', m.user, m.mode);
    });
    this.ircClient.chanMode.subscribe((m) => {
      // TODO: ...
    });
    this.ircClient.userChannelMode.subscribe((m) => {
      const chat = this.chatList.find((c) => c.target().name === m.channel || c.target().prefix === m.channel);
      if (chat) {
        m.mode = m.mode.split('');
        const mode = m.mode.shift();
        let flag = '';
        m.mode.forEach((userMode, i) => {
          switch (userMode) {
            case 'q':
              flag = '~';
              break;
            case 'a':
              flag = '&';
              break;
            case 'o':
              flag = '@';
              break;
            case 'h':
              flag = '%';
              break;
            case 'v':
              flag = '+';
              break;
          }
          const user = chat.users.find((u) => u.name === m.users[i]);
          if (user) {
            user.flags.replace(flag, '');
            if (mode === '+') {
              user.flags += flag;
            }
            user.icon = this.getIcon(user.flags);
            user.color = this.getColor(user.flags);
          }
        });
      }
    });
    this.ircClient.awayReply.subscribe((msg) => {
      msg.type = ChatMessageType.MESSAGE;
      const chat = this.chat(msg.sender).receive(msg);
      // Mark the sender user as AWAY
      // TODO: flag the sender user as marked away
      // TODO: this require a global users list to be implemented
      const channel = this.channel();
      if (channel) {
        const user = channel.getUser(msg.sender);
        if (user) {
          user.away = msg.message;
        }
      }
    });
  }

  ngOnInit() {
    this.messageWindow.mediaUrlClick.subscribe((mediaUrl) => {
      if (mediaUrl.id) {
        // YouTube link is opened with built-in player
        this.videoPlayer.loadVideo(mediaUrl.id);
      } else {
        // Other links are opened in a new window
        window.open(mediaUrl.link, '_blank');
      }
    });
    if (this.loginInfo) {
      this.ircClient.config.nick = this.loginInfo.nick;
      this.ircClient.config.password = this.loginInfo.password;
    }
    // work-around for ngCheckExpressioneChanged...
    setTimeout(this.connect.bind(this), 100);
  }

  onChatMenuButtonClick(c: ChatData) {
    this.currentMenuChat = c;
  }
  onChatButtonClick(c: ChatData) {
    const chat = this.show(c.target());
    if (this.screenWidth < 640) {
      this.showRightPanel = false;
      this.videoPlayer.toggleRightMargin(false);
    }
  }
  onCloseChatClick(c: ChatData) {
    // TODO:
    this.show(this.channel().info);
    c.hidden = true;
  }

  onUserClick(menu: MatMenu, user: ChatUser) {
    this.currentUser = user;
  }

  onUserMenuChat() {
    const chat = this.show(this.currentUser.name);
    this.showUserList = chat.hasUsers();
  }

  onUserPlaylistClick(user: ChatUser) {
    const dialogRef = this.dialog.open(MediaPlaylistComponent, {
      panelClass: 'playlist-dialog-container',
      width: '330px',
      data: user
    });
    dialogRef.afterClosed().subscribe(media => {
      if (media) {
        let videoId = '';
        if (media.url.indexOf('v=') === -1) {
          videoId = media.url.substring(media.url.lastIndexOf('/') + 1);
        } else {
          videoId = media.url.split('v=')[1];
          const ampersandPosition = videoId.indexOf('&');
          if (ampersandPosition !== -1) {
            videoId = videoId.substring(0, ampersandPosition);
          }
        }
        this.videoPlayer.loadVideo(videoId);
      }
    });
  }

  onEnterKey(e) {
    e.preventDefault();
    // TODO: make a method 'sendMessage' out of this
    // strip unwanted characters codes from string
    let message = this.userMessage.replace(/[\x00-\x1F\x7F]/gu, '');
    if (message.trim() !== '') {
      let spaceIndex = message.indexOf(' ');
      if (message[0] === '/' && spaceIndex > 0) {
        const command = message.substring(1, spaceIndex);
        let target = message = message.substring(spaceIndex + 1);
        if (command === 'ME') {
          this.userAction(message);
        } else {
          spaceIndex = message.indexOf(' ');
          if (spaceIndex > 0) {
            target = message.substring(0, spaceIndex);
            message = message.substring(spaceIndex + 1);
          }
          switch (command) {
            case 'NICK':
              this.ircClient.nick(target);
              break;
            case 'QUERY':
            case 'MSG':
              this.chat(target).send(message);
              break;
          }
        }
      } else {
        this.chat().send(message);
      }
    }
    this.userMessage = '';
    this.scrollToLast(true);
  }

  onOpenEmojiClick(e) {
    const dialogRef = this.dialog.open(EmojiDialogComponent, {panelClass: 'emoji-dialog-container'});
    dialogRef.afterClosed().subscribe(emoji => {
      if (emoji) {
        const leftPart = this.userMessage.substring(0, this.textInputCaretPosition);
        const rightPart = this.userMessage.substring(this.textInputCaretPosition);
        this.userMessage = leftPart + emoji.native + rightPart;
        this.textInputCaretPosition += emoji.native.length;
      }
      this.currentEmojiTextInput.focus();
    });
    e.preventDefault();
  }

  onTextInputBlur(e) {
    const textInput = this.currentEmojiTextInput = e.target;
    if (textInput.selectionStart || textInput.selectionStart == '0') {
      this.textInputCaretPosition = textInput.selectionStart;
    }
  }
  onTextInputFocus(e) {
    const textInput = e.target;
    setTimeout(() => {
      textInput.selectionStart = textInput.selectionEnd = this.textInputCaretPosition;
    }, 50);
  }

  showChatList() {
    this.showUserList = false;
    this.showRightPanel = true;
    this.videoPlayer.toggleRightMargin(true);
  }
  showChatUsers() {
    this.show(this.channel().info);
    this.showUserList = true;
    this.showRightPanel = true;
    this.videoPlayer.toggleRightMargin(true);
  }

  // hide/show join/part/kick/quit messages
  toggleChannelActivity() {
    const chat = this.channel();
    if (chat) {
      chat.preferences.showChannelActivity = !chat.preferences.showChannelActivity;
    }
  }

  scrollToLast(force?: boolean) {
    this.messageWindow.scrollLast(force);
  }

  userAction(message: string) {
    // TODO: this.ircClient.action(target, message)
    message = `\x01ACTION ${message}\x01`;
    this.chat(this.currentChatInfo.name).send(message);
  }
  setAway(reason?: string) {
    this.awayMessage = reason;
    this.ircClient.away(reason);
  }

  newMessageCount() {
    let newMessages = 0;
    this.chatList.forEach((c) => {
      if (c.info !== this.currentChatInfo && !c.hidden) {
        newMessages += c.stats.messages.new;
      }
    });
    return newMessages;
  }

  toggleRightPanel() {
    this.showRightPanel = false;
    this.videoPlayer.toggleRightMargin(false);
  }

  connect() {
    this.isLoggedIn = false;
    this.chatLoading.emit(true);
    this.chatList.forEach((c) => {
      c.users = [] as ChatUser[];
    });
    this.ircClient.connect().subscribe(null, (error) => {
console.log(error)
      this.isLoggedIn = false;
      this.snackBar.open('Connessione interrotta.','Connetti', {
        verticalPosition: 'top'
      }).onAction().subscribe(() => {
        this.connect();
      });
    }, () => {
      this.isLoggedIn = false;
      this.snackBar.open('Connessione interrotta.','Connetti', {
        verticalPosition: 'top'
      }).onAction().subscribe(() => {
        this.connect();
      });
    });
  }

  disconnect() {
    this.ircClient.disconnect();
  }

  client() {
    return this.ircClient;
  }

  show(target: string | ChatInfo) {
    this.chatLoading.emit(true);
    const chat = this.chat(target);
    setTimeout(() => {
      this.currentChatInfo = chat.target();
      chat.stats.messages.new = 0;
      this.messageWindow.bind(chat);
      if (!chat.info.name.startsWith('#')) {
        this.showUserList = false;
      }
      if (!this.deviceService.isMobile()) {
        // TODO: focus input text
        (this.messageInput.nativeElement as HTMLElement).focus();
      }
      this.chatLoading.emit(false);
    });
    return chat;
  }

  channel(target?: string | ChatInfo): ChatData {
    return this.chatList.find((c) => {
      return c.hasUsers()
        && (target == null || c.target() === target || c.target().name === target || c.target().prefix === target);
    });
  }
  chat(target?: string | ChatInfo): ChatData {
    if (target == null && this.currentChatInfo) {
      return this.chat(this.currentChatInfo);
    } else if (target == null) {
      return new ChatData('server', this);
    }
    let chat = this.chatList.find((c) => c.target() === target || c.target().name === target || c.target().prefix === target);
    if (chat == null) {
      chat = new ChatData(target, this);
      this.chatList.push(chat);
      if (target) {
        // force *ngFor refresh by re-assigning chatList
        this.boundChatList = this.chatList.slice();
        // automatically open chat if it's a channel
        if (chat.info.name[0] === '#') { // TODO: add facility 'chat.isChannel()'
          this.showUserList = true;
          this.chatOpen.emit(chat);
          this.show(target);
        } else if (this.screenWidth <= 640) {
          this.showRightPanel = false;
          this.videoPlayer.toggleRightMargin(false);
        }
      }
    }
    chat.hidden = false;
    return chat;
  }

  filterChat(chat: ChatData) {
    return !chat.hidden;
  }

  /*

  IRC User Roles
  --------------
  ~ for owners – to get this, you need to be +q in the channel
  & for admins – to get this, you need to be +a in the channel
  @ for full operators – to get this, you need to be +o in the channel
  % for half operators – to get this, you need to be +h in the channel
  + for voiced users – to get this, you need to be +v in the channel

  */

  getColor(c: ChatData | string): string {
    if (c == null) {
      return 'error';
    }
    let prefix = '';
    if (typeof c === 'string') {
      prefix = c;
    } else {
      if (c.hasUsers()) {
        return 'primary';
      }
      prefix = c.info.name;
    }
    if (this.isAdministrator(prefix) || this.isOwner(prefix)) {
      return 'accent';
    }
    if (this.isOperator(prefix)) {
      return 'primary';
    }
    if (this.isHalfOperator(prefix)) {
      return 'warn';
    }
    return '';
  }

  getIcon(c: ChatData | string): string {
    if (c == null) {
      return 'error';
    }
    let prefix = '';
    if (typeof c === 'string') {
      prefix = c;
    } else {
      if (c.hasUsers()) {
        return 'people_alt';
      }
      prefix = c.info.name;
    }
    if (this.isOwner(prefix)) {
      return 'stars';
    }
    if (this.isAdministrator(prefix)) {
      return 'security';
    }
    if (this.isOperator(prefix)) {
      return 'security';
    }
    if (this.isHalfOperator(prefix)) {
      return 'how_to_reg';
    }
    if (this.isVoice(prefix)) {
      return 'record_voice_over';
    }
    return 'person';
  }

  isOwner(name) {
    return name.indexOf('~') >= 0;
  }

  isAdministrator(name) {
    return name.indexOf('&') >= 0;
  }

  isHalfOperator(name) {
    return name.indexOf('%') >= 0;
  }

  isOperator(name) {
    return name.indexOf('@') >= 0;
  }

  isVoice(name) {
    return name.indexOf('+') >= 0;
  }

  removeUserNameFlags(name: string): string {
    return name.replace(/[~&@%+]/g,'');
  }

  getUsersList(target: string) {
    const chat = this.chatList.find((c) => c.target().name === target || c.target().prefix === target);
    return chat && chat.users;
  }

  private addChatUser(target: string, ...users: string[]) {
    const usersList = this.getUsersList(target);
    users.map((u) => {
      const user = new ChatUser();
      user.name = this.removeUserNameFlags(u);
      user.color = this.getColor(u);
      user.icon = this.getIcon(u);
      user.flags = this.getUserNameFlags(u);
      const existingUser = usersList.find((eu) => eu.name === user.name);
      if (existingUser == null) {
        usersList.push(user);
      }
      return user;
    });
    this.sortUsersList(target);
    const chat = this.chatList.find((c) => c.target().name === target || c.target().prefix === target);
    chat.users = [...usersList];
  }
  private renChatUser(user: string, nick: string) {
    this.chatList.forEach((c) => {
      if (c.hasUsers()) {
        const userList = c.users;
        const u = userList.find((n) => n.name === user);
        if (u != null) {
          u.name = nick;
          this.sortUsersList(c.info.name);
        }
      }
    });
  }
  private delChatUser(target: string, user: string) {
    if (target == null) {
      // TODO: .... (for better perfs, this should be implemented
      //    via keeping a global list of users instead of instances
      //    for each channel)
      this.chatList.forEach((c) => {
        if (c.hasUsers()) {
          const userList = c.users;
          const u = userList.find((n) => n.name === user);
          const ui = userList.indexOf(u);
          if (ui !== -1) {
            userList.splice(ui, 1);
          }
        }
      });
    } else {
      const userList = this.getUsersList(target);
      const u = userList.find((n) => n.name === user);
      const ui = userList.indexOf(u);
      if (ui !== -1) {
        userList.splice(ui, 1);
      }
    }
  }
  private sortUsersList(target: string) {
    this.getUsersList(target).sort((a, b) => {
      if (this.getUsersSortValue(a) < this.getUsersSortValue(b)) {
        return -1;
      }
      if (this.getUsersSortValue(a) > this.getUsersSortValue(b)) {
        return 1;
      }
      return 0;
    });
  }
  private getUsersSortValue(u: ChatUser) {
    let user = u.flags + u.name.toLowerCase();
    if (this.isOwner(user)) {
      user = user.replace('~', '0:');
    } else if (this.isAdministrator(user)) {
      user = user.replace('&', '1:');
    } else if (this.isOperator(user)) {
      user = user.replace('@', '2:');
    } else if (this.isHalfOperator(user)) {
      user = user.replace('%', '3:');
    } else if (this.isVoice(user)) {
      user = user.replace('+', '4:');
//    } else if (u.hasPlaylist()) {
//      user = '5:' + user;
    } else {
      user = '6:' + user;
    }
    user = this.removeUserNameFlags(user);
    return user;
  }

  private getUserNameFlags(user: string): string {
    let flags = '';
    const chars = ['~', '&', '@', '%', '+'];
    while (chars.indexOf(user[0]) !== -1) {
      flags += user[0];
      user = user.substring(1);
    }
    return flags;
  }

  isLastMessageVisible() {
    return this.messageWindow.isLastMessageVisible;
  }
}
