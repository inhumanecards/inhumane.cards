import React from 'react';

export default function bootstrap() {
  var CommentBox = React.createClass({
    render: function() {
      return (
          <div class="commentBox">Hello, world! I am a CommentBox</div>
        );
    }
  });
  React.render(
    React.createElement(CommentBox, null),
    document.getElementById('content')
  );
}
