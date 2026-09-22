module Gtd.Command.Pomodoro exposing (Command(..), encode)

{-| Commands the Pomodoro view alone is allowed to send.
-}

import Gtd.Command as Base
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.PomodoroOutcome exposing (PomodoroOutcome)
import Json.Encode as Encode


type Command
    = StartPomodoro { projectId : ProjectId, intention : String, focusActionIds : List ActionId, minutes : Int }
    | PausePomodoro
    | ResumePomodoro
    | FinishPomodoro (Maybe PomodoroOutcome) String
    | DiscardPomodoro
    | CompletePomodoroAction ActionId
    | ShowProject ProjectId


encode : Command -> Encode.Value
encode command =
    Base.encode
        (case command of
            StartPomodoro fields ->
                Base.StartPomodoro fields

            PausePomodoro ->
                Base.PausePomodoro

            ResumePomodoro ->
                Base.ResumePomodoro

            FinishPomodoro outcome reflection ->
                Base.FinishPomodoro outcome reflection

            DiscardPomodoro ->
                Base.DiscardPomodoro

            CompletePomodoroAction actionId ->
                Base.CompletePomodoroAction actionId

            ShowProject projectId ->
                Base.ShowProject projectId
        )
