module Gtd.Command.Pomodoro exposing (Command(..), encode)

{-| Commands the Pomodoro view alone is allowed to send.
-}

import Gtd.Checklist exposing (MarkState)
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
    | ToggleTicking
    | CompletePomodoroAction ActionId
    | ShowProject ProjectId
    | StartChecklistPomodoro { path : String, intention : String, minutes : Int }
    | MarkChecklistItem { runId : String, key : String, state : MarkState }
    | OpenChecklistRun String


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

            ToggleTicking ->
                Base.TogglePomodoroTicking

            CompletePomodoroAction actionId ->
                Base.CompletePomodoroAction actionId

            ShowProject projectId ->
                Base.ShowProject projectId

            StartChecklistPomodoro fields ->
                Base.StartChecklistPomodoro fields

            MarkChecklistItem fields ->
                Base.MarkChecklistItem fields

            OpenChecklistRun runId ->
                Base.OpenChecklistRun runId
        )
