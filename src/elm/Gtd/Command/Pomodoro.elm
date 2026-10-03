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
      -- "off", "ticking" or "folder".
    | SetSound String
    | OpenLink String
    | OpenNoteLink String String
    | CompletePomodoroAction ActionId
    | ShowProject ProjectId
    | StartChecklistPomodoro { path : String, intention : String, minutes : Int }
    | MarkChecklistItem { runId : String, key : String, state : MarkState }
    | OpenChecklistRun String
      -- The session's Support Material, as on the Project page.
    | OpenFile String
    | CreateSupportNote ProjectId String
    | CreateSupportFolder ProjectId String
    | ReadSupportNote ProjectId String
    | UpdateSupportNote ProjectId String String
    | LinkProjectFile ProjectId
    | UnlinkProjectFile ProjectId String
    | AddProjectLink ProjectId String String
    | RemoveProjectLink ProjectId String


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

            SetSound sound ->
                Base.SetPomodoroSound sound

            OpenLink url ->
                Base.OpenLink url

            OpenNoteLink link sourcePath ->
                Base.OpenNoteLink link sourcePath

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

            OpenFile path ->
                Base.OpenFile path

            CreateSupportNote projectId title ->
                Base.CreateSupportNote projectId title

            CreateSupportFolder projectId path ->
                Base.CreateSupportFolder projectId path

            ReadSupportNote projectId path ->
                Base.ReadSupportNote projectId path

            UpdateSupportNote projectId path body ->
                Base.UpdateSupportNote projectId path body

            LinkProjectFile projectId ->
                Base.LinkProjectFile projectId

            UnlinkProjectFile projectId link ->
                Base.UnlinkProjectFile projectId link

            AddProjectLink projectId url title ->
                Base.AddProjectLink projectId url title

            RemoveProjectLink projectId entry ->
                Base.RemoveProjectLink projectId entry
        )
